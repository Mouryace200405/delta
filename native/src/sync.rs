//! Vault synchronisation with GitHub.
//!
//! The vault folder is the git working tree: notes, attachments and drawings
//! are committed and pushed, while Delta's own metadata folder stays out of
//! the repository because it is a local cache that every device rebuilds.
//!
//! Authentication uses a personal access token that is passed to git as an
//! `Authorization` header, so it never ends up in `.git/config` on disk.

use crate::error::to_napi_err;
use napi::bindgen_prelude::*;
use napi_derive::napi;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

/// Files that are large or binary travel through Git LFS.
const LFS_PATTERNS: &[&str] = &[
    "*.png",
    "*.jpg",
    "*.jpeg",
    "*.gif",
    "*.webp",
    "*.avif",
    "*.bmp",
    "*.pdf",
    "*.mp3",
    "*.wav",
    "*.m4a",
    "*.ogg",
    "*.mp4",
    "*.mov",
    "*.excalidraw",
    "attachments/**",
    "drawings/**",
];

/// Everything Delta knows about the sync setup of a vault.
#[napi(object)]
pub struct SyncStatus {
    /// True when a repository is configured for this vault.
    pub configured: bool,
    /// The `owner/name` of the GitHub repository.
    pub repo: Option<String>,
    /// The branch that is used.
    pub branch: String,
    /// True when the `git` executable was found.
    pub git_available: bool,
    /// True when `git-lfs` was found.
    pub lfs_available: bool,
    /// True when large files are routed through Git LFS.
    pub lfs_enabled: bool,
    /// True when the vault folder is a git working tree.
    pub is_repo: bool,
    /// True when there are uncommitted changes waiting to be pushed.
    pub pending_changes: bool,
    /// Files that carry conflict markers and need the user's attention.
    pub conflict_files: Vec<String>,
    /// The subject of the most recent commit.
    pub last_commit: Option<String>,
    /// When the last successful sync finished, in milliseconds since the epoch.
    pub last_sync: Option<f64>,
    /// The last error, when the last attempt failed.
    pub last_error: Option<String>,
}

/// The outcome of one sync operation.
#[napi(object)]
pub struct SyncResult {
    /// True when the operation finished without errors.
    pub ok: bool,
    /// What was done: `push`, `pull` or `sync`.
    pub action: String,
    /// A short description suitable for showing to the user.
    pub message: String,
    /// How many commits were created or merged.
    pub commits: f64,
    /// How many files the operation touched.
    pub files_changed: f64,
    /// True when the two sides could not be merged automatically.
    pub conflict: bool,
    /// When the operation finished, in milliseconds since the epoch.
    pub last_sync: f64,
}

/// Result of running a git command.
struct GitOutput {
    ok: bool,
    stdout: String,
    stderr: String,
}

fn now_ms() -> f64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as f64)
        .unwrap_or(0.0)
}

/// True when the `git` executable is on the path.
fn git_available() -> bool {
    Command::new("git")
        .arg("--version")
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

/// True when `git-lfs` is installed.
fn lfs_available() -> bool {
    Command::new("git")
        .arg("lfs")
        .arg("version")
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

/// Run a git command inside the vault.
fn git(root: &Path, args: &[&str], token: Option<&str>) -> GitOutput {
    let mut command = Command::new("git");
    command.current_dir(root);

    // The token travels as a header so it is never written to disk.
    if let Some(token) = token.filter(|t| !t.is_empty()) {
        command.arg("-c").arg(format!(
            "http.https://github.com/.extraheader=Authorization: Bearer {token}"
        ));
    }
    for arg in args {
        command.arg(arg);
    }

    match command.output() {
        Ok(output) => GitOutput {
            ok: output.status.success(),
            stdout: String::from_utf8_lossy(&output.stdout).to_string(),
            stderr: String::from_utf8_lossy(&output.stderr).to_string(),
        },
        Err(error) => GitOutput {
            ok: false,
            stdout: String::new(),
            stderr: error.to_string(),
        },
    }
}

/// The remote URL for a repository.
///
/// A bare `owner/repo` is turned into a GitHub URL. Anything that already
/// looks like a URL is used as it is, and local paths are supported too so a
/// vault can be synced with a plain git server on the same network.
fn remote_url(repo: &str) -> String {
    let repo = repo.trim();
    if repo.starts_with("http://")
        || repo.starts_with("https://")
        || repo.starts_with("git@")
        || repo.starts_with("ssh://")
        || repo.starts_with("file://")
        || repo.starts_with('/')
        || repo.starts_with('.')
    {
        repo.to_string()
    } else {
        format!("https://github.com/{}.git", repo.trim_matches('/'))
    }
}

/// Append a managed block to a file, leaving anything else alone.
fn ensure_block(path: &Path, marker: &str, content: &str) -> std::io::Result<()> {
    let existing = std::fs::read_to_string(path).unwrap_or_default();
    if existing.contains(marker) {
        return Ok(());
    }
    let mut text = existing;
    if !text.is_empty() && !text.ends_with('\n') {
        text.push('\n');
    }
    if !text.is_empty() {
        text.push('\n');
    }
    text.push_str(marker);
    text.push('\n');
    text.push_str(content);
    if !text.ends_with('\n') {
        text.push('\n');
    }
    std::fs::write(path, text)
}

/// Prepare the vault for syncing: repository, ignore rules and LFS settings.
fn prepare(
    root: &Path,
    repo: &str,
    branch: &str,
    use_lfs: bool,
) -> std::result::Result<(), String> {
    if !root.join(".git").exists() {
        let output = git(root, &["init", "-b", branch], None);
        if !output.ok {
            return Err(format!("could not create the repository: {}", output.stderr.trim()));
        }
    }

    // Delta's own folder is a local cache and must never be committed.
    ensure_block(
        &root.join(".gitignore"),
        "# delta-managed",
        ".delta/\n",
    )
    .map_err(|e| format!("could not write .gitignore: {e}"))?;

    if use_lfs {
        let mut block = String::new();
        for pattern in LFS_PATTERNS {
            block.push_str(&format!("{pattern} filter=lfs diff=lfs merge=lfs -text\n"));
        }
        ensure_block(&root.join(".gitattributes"), "# delta-managed", &block)
            .map_err(|e| format!("could not write .gitattributes: {e}"))?;
        let output = git(root, &["lfs", "install", "--local"], None);
        if !output.ok {
            return Err(format!(
                "Git LFS could not be enabled: {}",
                output.stderr.trim()
            ));
        }
    }

    // Give git an identity when the machine has none.
    let name = git(root, &["config", "user.name"], None);
    if !name.ok || name.stdout.trim().is_empty() {
        git(root, &["config", "user.name", "Delta"], None);
    }
    let email = git(root, &["config", "user.email"], None);
    if !email.ok || email.stdout.trim().is_empty() {
        git(root, &["config", "user.email", "delta@localhost"], None);
    }

    let url = remote_url(repo);
    let existing = git(root, &["remote", "get-url", "origin"], None);
    if existing.ok {
        git(root, &["remote", "set-url", "origin", &url], None);
    } else {
        git(root, &["remote", "add", "origin", &url], None);
    }

    Ok(())
}

/// Point `origin` at a repository, adding the remote when it is missing.
fn set_remote(root: &Path, repo: &str) {
    let url = remote_url(repo);
    let existing = git(root, &["remote", "get-url", "origin"], None);
    if existing.ok {
        if existing.stdout.trim() != url {
            git(root, &["remote", "set-url", "origin", &url], None);
        }
    } else {
        git(root, &["remote", "add", "origin", &url], None);
    }
}

/// Count the commits a revision points at, `0` when it does not exist yet.
fn count_commits(root: &Path, revision: &str) -> f64 {
    git(root, &["rev-list", "--count", revision], None)
        .stdout
        .trim()
        .parse::<f64>()
        .unwrap_or(0.0)
}

/// True when the revision resolves to a commit.
fn revision_exists(root: &Path, revision: &str) -> bool {
    git(root, &["rev-parse", "--verify", "--quiet", revision], None).ok
}

/// The files that still need the user to decide.
///
/// A merge that conflicts is left open on purpose: the conflict markers end
/// up in the note itself, so the user can decide what to keep and sync
/// again. Nothing is thrown away and nothing is merged behind their back.
///
/// The check looks at the files themselves rather than at the index, because
/// the index keeps a file marked as conflicted until it is staged again —
/// and the user resolves the note, not the index.
fn unresolved_conflicts(root: &Path) -> Vec<String> {
    if !revision_exists(root, "MERGE_HEAD") {
        return Vec::new();
    }

    // The markers in the working tree are what counts: git keeps a file
    // marked as conflicted in the index until it is staged again, so the
    // index would report a conflict that the user has already resolved.
    git(root, &["grep", "-l", "-e", "<<<<<<<"], None)
        .stdout
        .lines()
        .filter(|line| !line.trim().is_empty())
        .map(|line| line.to_string())
        .collect()
}

/// Stage everything and commit, returning the number of new commits.
fn commit(root: &Path, message: &str) -> (f64, f64) {
    // A merge that is still waiting for a decision must not be committed
    // with its conflict markers in place.
    if !unresolved_conflicts(root).is_empty() {
        return (0.0, 0.0);
    }

    let before = count_commits(root, "HEAD");
    let has_head = revision_exists(root, "HEAD");

    git(root, &["add", "-A"], None);
    let status = git(root, &["status", "--porcelain"], None);
    let dirty = !status.stdout.trim().is_empty();
    let changed = status.stdout.lines().count() as f64;

    if !dirty && has_head {
        return (0.0, 0.0);
    }

    if dirty {
        let output = git(root, &["commit", "-m", message], None);
        if !output.ok {
            return (0.0, changed);
        }
    } else {
        // An empty vault still needs a commit, otherwise the branch has
        // nothing to push and Git refuses the push.
        git(root, &["commit", "--allow-empty", "-m", message], None);
    }

    let after = count_commits(root, "HEAD");
    ((after - before).max(0.0), changed)
}

/// Report the current state of the sync setup for a vault.
#[napi]
pub fn sync_status(vault_root: String, repo: Option<String>, branch: Option<String>) -> SyncStatus {
    let root = PathBuf::from(&vault_root);
    let branch = branch.unwrap_or_else(|| "main".to_string());
    let is_repo = root.join(".git").exists();
    let git_ok = git_available();
    let lfs_ok = lfs_available();

    let mut pending_changes = false;
    let mut last_commit = None;
    let mut conflict_files = Vec::new();
    if is_repo && git_ok {
        let status = git(&root, &["status", "--porcelain"], None);
        pending_changes = !status.stdout.trim().is_empty();
        let log = git(&root, &["log", "-1", "--pretty=%s"], None);
        if log.ok {
            let subject = log.stdout.trim().to_string();
            if !subject.is_empty() {
                last_commit = Some(subject);
            }
        }
        conflict_files = unresolved_conflicts(&root);
    }

    let lfs_enabled = is_repo
        && lfs_ok
        && std::fs::read_to_string(root.join(".gitattributes"))
            .map(|text| text.contains("filter=lfs"))
            .unwrap_or(false);

    SyncStatus {
        configured: repo.as_ref().map(|r| !r.is_empty()).unwrap_or(false) && is_repo,
        repo,
        branch,
        git_available: git_ok,
        lfs_available: lfs_ok,
        lfs_enabled,
        is_repo,
        pending_changes,
        conflict_files,
        last_commit,
        last_sync: None,
        last_error: None,
    }
}

/// Prepare the vault for syncing and make the first commit.
#[napi]
pub fn sync_setup(
    vault_root: String,
    repo: String,
    branch: Option<String>,
    use_lfs: Option<bool>,
) -> Result<SyncResult> {
    let root = PathBuf::from(&vault_root);
    if !root.is_dir() {
        return Err(to_napi_err("ENOTDIR", "the vault folder does not exist"));
    }
    if !git_available() {
        return Err(to_napi_err(
            "ENOTFOUND",
            "git is not installed on this machine",
        ));
    }
    let branch = branch.unwrap_or_else(|| "main".to_string());
    let use_lfs = use_lfs.unwrap_or(true) && lfs_available();

    prepare(&root, &repo, &branch, use_lfs).map_err(|e| to_napi_err("EIO", &e))?;
    let (commits, files) = commit(&root, "Delta: start syncing this vault");

    Ok(SyncResult {
        ok: true,
        action: "setup".to_string(),
        message: format!("{repo} is ready to sync"),
        commits,
        files_changed: files,
        conflict: false,
        last_sync: now_ms(),
    })
}

/// Commit local changes and push them.
#[napi]
pub fn sync_push(
    vault_root: String,
    repo: Option<String>,
    branch: Option<String>,
    token: Option<String>,
    message: Option<String>,
) -> Result<SyncResult> {
    let root = PathBuf::from(&vault_root);
    let branch = branch.unwrap_or_else(|| "main".to_string());
    let token = token.as_deref();

    if let Some(repo) = repo.filter(|r| !r.is_empty()) {
        set_remote(&root, &repo);
    }

    // A merge that is still waiting for a decision must not be pushed.
    let pending = unresolved_conflicts(&root);
    if !pending.is_empty() {
        return Ok(SyncResult {
            ok: false,
            action: "push".to_string(),
            message: format!(
                "Resolve the conflict markers in {} and sync again.",
                pending.join(", ")
            ),
            commits: 0.0,
            files_changed: pending.len() as f64,
            conflict: true,
            last_sync: now_ms(),
        });
    }

    let (_commits, files) = commit(&root, message.as_deref().unwrap_or("Delta: sync"));

    // The push always runs, even when the worktree is clean: commits that
    // were made earlier — the very first one after `sync_setup`, for
    // instance — still have to reach the remote.
    let remote_ref = format!("origin/{branch}");
    let remote_before = count_commits(&root, &remote_ref);
    let local_before = count_commits(&root, "HEAD");

    let output = git(&root, &["push", "-u", "origin", &branch], token);
    if !output.ok {
        let detail = extract_git_error(&combined_output(&output));
        return Err(to_napi_err("EIO", &detail));
    }

    let pushed = (local_before - remote_before).max(0.0);
    let up_to_date = output.stdout.contains("Everything up-to-date")
        || output.stderr.contains("Everything up-to-date");

    // Count the files that the pushed commits touched.
    let changed_files = if pushed > 0.0 && revision_exists(&root, &remote_ref) {
        let range = format!("{remote_ref}..HEAD");
        git(&root, &["diff", "--name-only", &range], None)
            .stdout
            .lines()
            .filter(|line| !line.trim().is_empty())
            .count() as f64
    } else {
        files
    };

    Ok(SyncResult {
        ok: true,
        action: "push".to_string(),
        message: if up_to_date && pushed == 0.0 {
            "Everything was already up to date".to_string()
        } else {
            format!("Pushed {pushed} change(s) to {branch}")
        },
        commits: pushed,
        files_changed: changed_files,
        conflict: false,
        last_sync: now_ms(),
    })
}

/// Fetch and merge remote changes.
#[napi]
pub fn sync_pull(
    vault_root: String,
    repo: Option<String>,
    branch: Option<String>,
    token: Option<String>,
) -> Result<SyncResult> {
    let root = PathBuf::from(&vault_root);
    let branch = branch.unwrap_or_else(|| "main".to_string());
    let token = token.as_deref();

    if !root.join(".git").exists() {
        return Err(to_napi_err(
            "ENOTFOUND",
            "this vault is not connected to a repository yet",
        ));
    }

    if let Some(repo) = repo.filter(|r| !r.is_empty()) {
        set_remote(&root, &repo);
    }

    // A merge that is still open has to be settled first, otherwise Git
    // refuses to merge anything on top of it.
    let pending = unresolved_conflicts(&root);
    if !pending.is_empty() {
        return Ok(SyncResult {
            ok: false,
            action: "pull".to_string(),
            message: format!(
                "Resolve the conflict markers in {} and sync again.",
                pending.join(", ")
            ),
            commits: 0.0,
            files_changed: 0.0,
            conflict: true,
            last_sync: now_ms(),
        });
    }

    // Fetch the whole remote instead of a single branch: a repository that
    // was just created has no branches at all, and asking for one by name
    // fails on it.
    let fetch = git(&root, &["fetch", "origin"], token);
    if !fetch.ok {
        let detail = extract_git_error(&combined_output(&fetch));
        return Err(to_napi_err("EIO", &detail));
    }

    let remote_ref = format!("origin/{branch}");
    if !revision_exists(&root, &remote_ref) {
        return Ok(SyncResult {
            ok: true,
            action: "pull".to_string(),
            message: format!("The remote branch `{branch}` does not exist yet"),
            commits: 0.0,
            files_changed: 0.0,
            conflict: false,
            last_sync: now_ms(),
        });
    }

    let before = count_commits(&root, "HEAD");

    let merge = git(
        &root,
        &["merge", "--no-edit", &remote_ref],
        token,
    );

    if !merge.ok {
        // Unrelated histories are fine on a first sync; real conflicts are not.
        let retry = git(
            &root,
            &[
                "merge",
                "--no-edit",
                "--allow-unrelated-histories",
                &remote_ref,
            ],
            token,
        );
        if !retry.ok {
            let conflicts = unresolved_conflicts(&root);
            if conflicts.is_empty() {
                // The merge never started, so there is nothing to clean up
                // and the reason has to come from Git itself.
                git(&root, &["merge", "--abort"], None);
                let detail = extract_git_error(&combined_output(&retry));
                return Ok(SyncResult {
                    ok: false,
                    action: "pull".to_string(),
                    message: detail,
                    commits: 0.0,
                    files_changed: 0.0,
                    conflict: true,
                    last_sync: now_ms(),
                });
            }
            // The merge stays open on purpose: the markers are in the note
            // so the user can pick the version they want.
            return Ok(SyncResult {
                ok: false,
                action: "pull".to_string(),
                message: format!(
                    "Another device changed {}. Open the note, keep what you want and sync again.",
                    conflicts.join(", ")
                ),
                commits: 0.0,
                files_changed: conflicts.len() as f64,
                conflict: true,
                last_sync: now_ms(),
            });
        }
    }

    let commits = (count_commits(&root, "HEAD") - before).max(0.0);

    let status = git(&root, &["status", "--porcelain"], None);
    let files = status.stdout.lines().count() as f64;

    Ok(SyncResult {
        ok: true,
        action: "pull".to_string(),
        message: if commits > 0.0 {
            format!("Pulled {commits} change(s) from {branch}")
        } else {
            "Already up to date".to_string()
        },
        commits,
        files_changed: files,
        conflict: false,
        last_sync: now_ms(),
    })
}

/// Pull remote changes and push local ones — the full two-way sync.
///
/// The order is Git's own: commit what is local, merge what is remote, then
/// push the result. Committing last would merge into a dirty worktree, which
/// Git refuses to do.
#[napi]
pub fn sync_now(
    vault_root: String,
    repo: Option<String>,
    branch: Option<String>,
    token: Option<String>,
    message: Option<String>,
) -> Result<SyncResult> {
    let root = PathBuf::from(&vault_root);
    let message = message.unwrap_or_else(|| "Delta: sync".to_string());

    let pending = unresolved_conflicts(&root);
    if !pending.is_empty() {
        return Ok(SyncResult {
            ok: false,
            action: "sync".to_string(),
            message: format!(
                "Resolve the conflict markers in {} and sync again.",
                pending.join(", ")
            ),
            commits: 0.0,
            files_changed: pending.len() as f64,
            conflict: true,
            last_sync: now_ms(),
        });
    }

    // The local changes have to be part of the history before the remote is
    // merged in.
    commit(&root, &message);

    let pull = sync_pull(vault_root.clone(), repo.clone(), branch.clone(), token.clone())?;
    if pull.conflict {
        return Ok(pull);
    }

    let push = sync_push(vault_root, repo, branch, token, Some(message))?;
    Ok(SyncResult {
        ok: push.ok,
        action: "sync".to_string(),
        message: if pull.commits > 0.0 && push.commits > 0.0 {
            format!("Pulled {} and pushed {} change(s)", pull.commits, push.commits)
        } else if pull.commits > 0.0 {
            pull.message
        } else {
            push.message
        },
        commits: pull.commits + push.commits,
        files_changed: pull.files_changed + push.files_changed,
        conflict: false,
        last_sync: now_ms(),
    })
}

/// Turn git's output into a short sentence the user can act on.
///
/// Git writes most of its interesting messages to stdout — a failed merge,
/// for instance, only touches stderr when something else went wrong as well.
fn extract_git_error(stderr: &str) -> String {
    let text = stderr.trim();
    if text.is_empty() {
        return "git did not report a reason".to_string();
    }
    if text.contains("CONFLICT") || text.contains("Automatic merge failed") {
        return "Another device changed the same files, so Git could not merge them. Your own changes are still in the vault.".to_string();
    }
    if text.contains("non-fast-forward") || text.contains("fetch first") {
        return "The remote has changes that are not here yet. Sync again to pull them in first.".to_string();
    }
    if text.contains("could not read Username")
        || text.contains("Authentication failed")
        || text.contains("403")
    {
        return "GitHub refused the token. Check that it is valid and has the `repo` scope.".to_string();
    }
    if text.contains("not found") && text.contains("Repository") {
        return "The repository does not exist on GitHub yet. Create it, then sync again.".to_string();
    }
    if text.contains("Permission denied") && text.contains("public key") {
        return "Git could not authenticate. Check the token and the repository permissions.".to_string();
    }
    if text.contains("git-lfs: command not found") || text.contains("git-lfs filter-process") {
        return "Git LFS is not installed, so large files cannot be pushed. Install git-lfs and try again.".to_string();
    }
    // Keep the last meaningful line, which git puts at the end.
    text.lines()
        .rev()
        .find(|line| !line.trim().is_empty())
        .unwrap_or(text)
        .trim()
        .to_string()
}

/// The output of git, with stdout and stderr joined so that a failure is
/// never reported without a reason.
fn combined_output(output: &GitOutput) -> String {
    let mut text = output.stdout.trim().to_string();
    let stderr = output.stderr.trim();
    if !stderr.is_empty() {
        if !text.is_empty() {
            text.push('\n');
        }
        text.push_str(stderr);
    }
    text
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_a_remote_url() {
        assert_eq!(
            remote_url("owner/repo"),
            "https://github.com/owner/repo.git"
        );
        assert_eq!(
            remote_url("https://github.com/owner/repo.git"),
            "https://github.com/owner/repo.git"
        );
    }

    #[test]
    fn keeps_urls_and_local_paths_as_they_are() {
        assert_eq!(
            remote_url("git@github.com:owner/repo.git"),
            "git@github.com:owner/repo.git"
        );
        assert_eq!(
            remote_url("file:///srv/git/vault.git"),
            "file:///srv/git/vault.git"
        );
        assert_eq!(remote_url("/srv/git/vault.git"), "/srv/git/vault.git");
    }

    #[test]
    fn explains_a_bad_token() {
        let message = extract_git_error("fatal: Authentication failed for 'https://github.com/x'");
        assert!(message.contains("token"));
    }

    #[test]
    fn reports_a_missing_repository() {
        let message = extract_git_error("remote: Repository not found.");
        assert!(message.contains("does not exist"));
    }

    #[test]
    fn explains_a_merge_conflict() {
        let message = extract_git_error(
            "CONFLICT (content): Merge conflict in Welcome.md\nAutomatic merge failed; fix conflicts and then commit the result.",
        );
        assert!(message.contains("could not merge"));
    }

    #[test]
    fn explains_a_rejected_push() {
        let message = extract_git_error(
            " ! [rejected]        main -> main (fetch first)\nhint: See the 'Note about fast-forwards' in 'git push --help'",
        );
        assert!(message.contains("Sync again"));
    }
}
