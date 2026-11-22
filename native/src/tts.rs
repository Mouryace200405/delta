//! Local text-to-speech through Piper.
//!
//! Piper is a separate program, so this module only discovers the binary and
//! the voice models that are installed, turns Markdown into speakable text and
//! runs the synthesiser. Audio is written to a temporary WAV file that the
//! player picks up.

use crate::error::to_napi_err;
use napi::bindgen_prelude::*;
use napi_derive::napi;
use once_cell::sync::Lazy;
use regex::Regex;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

/// A voice model found on disk.
#[napi(object)]
pub struct TtsVoice {
    /// Display name, taken from the model file name.
    pub name: String,
    /// Absolute path of the `.onnx` model.
    pub path: String,
    /// Language recorded in the model config, when present.
    pub language: Option<String>,
    /// Size of the model file in bytes.
    pub size: f64,
}

/// The state of the local speech setup.
#[napi(object)]
pub struct TtsStatus {
    /// True when Piper and at least one voice are usable.
    pub available: bool,
    /// Path of the Piper executable, when one was found.
    pub piper_path: Option<String>,
    /// Folder the voices were searched in.
    pub model_dir: Option<String>,
    /// Voices that were found.
    pub voices: Vec<TtsVoice>,
    /// Why speech is unavailable, when it is.
    pub error: Option<String>,
}

/// The synthesiser process that is currently running, if any.
static RUNNING: Lazy<Arc<Mutex<Option<Child>>>> = Lazy::new(|| Arc::new(Mutex::new(None)));

/// Look for the Piper executable.
///
/// The `DELTA_PIPER` environment variable wins, then the usual places on
/// `PATH`, then the locations a Python install drops it in.
fn find_piper() -> Option<String> {
    if let Ok(custom) = std::env::var("DELTA_PIPER") {
        let path = PathBuf::from(&custom);
        if path.is_file() {
            return Some(custom);
        }
    }

    if let Ok(path) = std::env::var("PATH") {
        for dir in path.split(':') {
            if dir.is_empty() {
                continue;
            }
            let candidate = Path::new(dir).join("piper");
            if candidate.is_file() {
                return Some(candidate.to_string_lossy().to_string());
            }
        }
    }

    let home = std::env::var("HOME").unwrap_or_default();
    let candidates = [
        format!("{home}/anaconda3/bin/piper"),
        format!("{home}/miniconda3/bin/piper"),
        format!("{home}/.local/bin/piper"),
        "/usr/local/bin/piper".to_string(),
        "/usr/bin/piper".to_string(),
    ];
    candidates
        .into_iter()
        .find(|candidate| Path::new(candidate).is_file())
}

/// Folders that are searched for voice models.
fn voice_dirs(extra: Option<&str>) -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = Vec::new();
    if let Ok(custom) = std::env::var("DELTA_VOICES") {
        dirs.push(PathBuf::from(custom));
    }
    if let Some(extra) = extra {
        if !extra.is_empty() {
            dirs.push(PathBuf::from(extra));
        }
    }
    let home = std::env::var("HOME").unwrap_or_default();
    dirs.push(PathBuf::from(format!("{home}/.local/share/piper/voices")));
    dirs.push(PathBuf::from(format!("{home}/.cache/piper")));
    dirs.push(PathBuf::from(format!("{home}/chati/backend/piper_voices")));
    dirs
        .into_iter()
        .filter(|dir| dir.is_dir())
        .collect()
}

/// Read the language recorded in a voice model's config file.
fn model_language(model: &Path) -> Option<String> {
    let config = model.with_extension("onnx.json");
    let text = std::fs::read_to_string(config).ok()?;
    let value: serde_json::Value = serde_json::from_str(&text).ok()?;
    value
        .get("espeak")
        .and_then(|e| e.get("voice"))
        .and_then(|v| v.as_str())
        .map(|v| v.split('-').next().unwrap_or(v).to_string())
}

/// Collect the voice models in a folder.
fn voices_in(dir: &Path) -> Vec<TtsVoice> {
    let mut voices = Vec::new();
    let Ok(entries) = std::fs::read_dir(dir) else {
        return voices;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("onnx") {
            continue;
        }
        let name = path
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("voice")
            .to_string();
        let size = entry.metadata().map(|m| m.len()).unwrap_or(0);
        voices.push(TtsVoice {
            name,
            path: path.to_string_lossy().to_string(),
            language: model_language(&path),
            size: size as f64,
        });
    }
    voices.sort_by(|a, b| a.name.cmp(&b.name));
    voices
}

/// List the voice models available on this machine.
#[napi]
pub fn list_tts_voices(voice_dir: Option<String>) -> Vec<TtsVoice> {
    let mut all = Vec::new();
    for dir in voice_dirs(voice_dir.as_deref()) {
        all.extend(voices_in(&dir));
    }
    all
}

/// Report whether speech is possible, and what is installed.
#[napi]
pub fn tts_status(voice_dir: Option<String>) -> TtsStatus {
    let piper_path = find_piper();
    let voices = list_tts_voices(voice_dir.clone());
    let model_dir = voice_dirs(voice_dir.as_deref())
        .first()
        .map(|dir| dir.to_string_lossy().to_string());

    let error = if piper_path.is_none() {
        Some("Piper was not found. Install it or point Delta at the executable.".to_string())
    } else if voices.is_empty() {
        Some("No Piper voice models were found. Download one and set the voices folder.".to_string())
    } else {
        None
    };

    TtsStatus {
        available: error.is_none(),
        piper_path,
        model_dir,
        voices,
        error,
    }
}

/// Remove the inline decoration that would otherwise be read out loud.
///
/// Emphasis markers are dropped wherever they appear, but an underscore
/// between two letters belongs to the word — `snake_case` is a name, not
/// decoration. A `#tag` is dropped as well, unless the hash is part of a word.
fn strip_inline_markdown(text: &str) -> String {
    let chars: Vec<char> = text.chars().collect();
    let mut out = String::with_capacity(text.len());
    let mut index = 0;

    while index < chars.len() {
        match chars[index] {
            '*' | '~' | '`' => index += 1,
            '_' => {
                let before = index.checked_sub(1).map(|i| chars[i]);
                let after = chars.get(index + 1).copied();
                let inside_word = before.map(|c| c.is_alphanumeric()).unwrap_or(false)
                    && after.map(|c| c.is_alphanumeric()).unwrap_or(false);
                if inside_word {
                    out.push('_');
                }
                index += 1;
            }
            '#' => {
                let before = index.checked_sub(1).map(|i| chars[i]);
                let on_its_own = before
                    .map(|c| !c.is_alphanumeric() && c != '/' && c != '#')
                    .unwrap_or(true);
                let mut end = index + 1;
                while end < chars.len()
                    && (chars[end].is_alphanumeric()
                        || chars[end] == '-'
                        || chars[end] == '_'
                        || chars[end] == '/')
                {
                    end += 1;
                }
                if on_its_own && end > index + 1 {
                    index = end;
                    continue;
                }
                out.push('#');
                index += 1;
            }
            other => {
                out.push(other);
                index += 1;
            }
        }
    }

    out
}

/// Strip Markdown decoration so the result reads naturally out loud.
///
/// The output is what a person would say: no hashes, no dashes, no bullet
/// characters and no table pipes. Code is kept, because the words in it are
/// still words.
pub fn markdown_to_speech(markdown: &str) -> String {
    let wikilink = Regex::new(r"\[\[([^\]|]+)(?:\|([^\]]+))?\]\]").unwrap();
    let image = Regex::new(r"!\[([^\]]*)\]\([^)]*\)").unwrap();
    let link = Regex::new(r"\[([^\]]*)\]\([^)]*\)").unwrap();
    let reference_link = Regex::new(r"\[([^\]]*)\]\[[^\]]*\]").unwrap();
    let reference = Regex::new(r"^\s*\[[^\]]+\]:\s*\S+.*$").unwrap();
    let html = Regex::new(r"<[^>]+>").unwrap();
    let heading = Regex::new(r"^#{1,6}\s*").unwrap();
    let setext = Regex::new(r"^={3,}\s*$").unwrap();
    let quote = Regex::new(r"^>\s*").unwrap();
    let bullet = Regex::new(r"^([-*+]|\d+[.)])\s+").unwrap();
    let checkbox = Regex::new(r"^\[[ xX]\]\s*").unwrap();
    let rule = Regex::new(r"^([-*_]\s*){3,}$").unwrap();
    let table_divider = Regex::new(r"^\|?[\s:|-]+\|[\s:|-]*$").unwrap();

    let mut out = String::new();
    let mut in_code = false;
    let lines: Vec<&str> = markdown.lines().collect();
    let mut index = 0;

    while index < lines.len() {
        let line = lines[index];
        let trimmed = line.trim();
        index += 1;

        // YAML frontmatter at the very top of the note is metadata, not prose.
        // It only counts when it is closed again further down.
        if !in_code && out.is_empty() && trimmed == "---" {
            let closed = lines[index..]
                .iter()
                .any(|later| matches!(later.trim(), "---" | "..."));
            if closed {
                while index < lines.len() {
                    let marker = lines[index].trim();
                    index += 1;
                    if marker == "---" || marker == "..." {
                        break;
                    }
                }
                continue;
            }
        }

        // Fenced code blocks are announced as code and read line by line.
        if trimmed.starts_with("```") || trimmed.starts_with("~~~") {
            in_code = !in_code;
            continue;
        }

        if in_code {
            if !trimmed.is_empty() {
                out.push_str(trimmed);
                out.push('\n');
            }
            continue;
        }

        // A horizontal rule is a divider, not a row of dashes.
        if rule.is_match(trimmed) {
            continue;
        }

        // Setext headings underline the line above them.
        if setext.is_match(trimmed) {
            continue;
        }

        // Link definitions at the bottom of a note are never spoken.
        if reference.is_match(trimmed) {
            continue;
        }

        let mut cleaned = trimmed.to_string();
        cleaned = heading.replace(&cleaned, "").to_string();
        cleaned = quote.replace(&cleaned, "").to_string();
        cleaned = bullet.replace(&cleaned, "").to_string();
        cleaned = checkbox.replace(&cleaned, "").to_string();
        cleaned = wikilink
            .replace_all(&cleaned, |caps: &regex::Captures| {
                let target = caps.get(1).map(|m| m.as_str()).unwrap_or("").trim();
                let alias = caps.get(2).map(|m| m.as_str()).unwrap_or("").trim();
                if alias.is_empty() {
                    target.trim_end_matches(".md").to_string()
                } else {
                    alias.to_string()
                }
            })
            .to_string();
        cleaned = image.replace_all(&cleaned, "$1").to_string();
        cleaned = link.replace_all(&cleaned, "$1").to_string();
        cleaned = reference_link.replace_all(&cleaned, "$1").to_string();
        cleaned = html.replace_all(&cleaned, "").to_string();
        cleaned = strip_inline_markdown(&cleaned);

        // Table rows are read as their cells, without the pipes. This runs
        // after the inline replacements, so a wikilink alias is never mistaken
        // for a column separator.
        if cleaned.contains('|') {
            if table_divider.is_match(&cleaned) {
                continue;
            }
            let cells: Vec<String> = cleaned
                .trim_matches('|')
                .split('|')
                .map(|cell| cell.trim().to_string())
                .filter(|cell| !cell.is_empty() && !table_divider.is_match(cell))
                .collect();
            if !cells.is_empty() {
                out.push_str(&cells.join(", "));
                out.push('\n');
            }
            continue;
        }

        let cleaned = collapse_spaces(&cleaned);
        if !cleaned.is_empty() {
            out.push_str(&cleaned);
            out.push('\n');
        }
    }

    out.trim().to_string()
}

/// Tidy text that is already plain prose.
///
/// The words are left exactly as they are; only the spacing is cleaned up, so
/// that a blank line becomes a pause rather than a stumble.
fn plain_to_speech(text: &str) -> String {
    text.lines()
        .map(|line| collapse_spaces(line))
        .filter(|line| !line.is_empty())
        .collect::<Vec<_>>()
        .join("\n")
}

/// Collapse runs of spaces and tabs into a single space.
fn collapse_spaces(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut space = false;
    for c in text.chars() {
        if c == ' ' || c == '\t' {
            space = true;
            continue;
        }
        if space && !out.is_empty() {
            out.push(' ');
        }
        space = false;
        out.push(c);
    }
    out.trim().to_string()
}

/// Wait for the running synthesiser, clearing the slot when it finishes.
fn watch_child(child_slot: Arc<Mutex<Option<Child>>>) {
    loop {
        {
            let mut guard = match child_slot.lock() {
                Ok(guard) => guard,
                Err(_) => return,
            };
            match guard.as_mut() {
                Some(child) => match child.try_wait() {
                    Ok(Some(_)) | Err(_) => {
                        *guard = None;
                        return;
                    }
                    Ok(None) => {}
                },
                None => return,
            }
        }
        std::thread::sleep(Duration::from_millis(60));
    }
}

/// Synthesise `text` with the given voice, returning the path of the WAV file.
///
/// The call resolves once the audio is ready; the caller plays it.
///
/// `plain` says that the text is already rendered prose rather than
/// Markdown. The interface reads the note the way it is shown on screen and
/// hands that over, so nothing has to be guessed about the syntax.
#[napi]
pub async fn speak(
    text: String,
    model_path: String,
    piper_path: Option<String>,
    length_scale: Option<f64>,
    plain: Option<bool>,
) -> Result<String> {
    let model = PathBuf::from(&model_path);
    if !model.is_file() {
        return Err(to_napi_err("ENOENT", "voice model not found"));
    }

    let piper = piper_path
        .filter(|path| !path.is_empty())
        .or_else(find_piper)
        .ok_or_else(|| to_napi_err("ENOTFOUND", "Piper was not found on this machine"))?;

    let spoken = if plain.unwrap_or(false) {
        plain_to_speech(&text)
    } else {
        markdown_to_speech(&text)
    };
    if spoken.is_empty() {
        return Err(to_napi_err("EINVAL", "there is nothing to read"));
    }

    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let out_dir = std::env::temp_dir().join("delta-speech");
    std::fs::create_dir_all(&out_dir).map_err(|e| to_napi_err("EIO", &format!("{e}")))?;
    let out_path = out_dir.join(format!("delta-{stamp}.wav"));

    let config = model.with_extension("onnx.json");
    let mut command = Command::new(&piper);
    command
        .arg("-m")
        .arg(&model)
        .arg("-f")
        .arg(&out_path);
    if config.is_file() {
        command.arg("-c").arg(&config);
    }
    if let Some(scale) = length_scale {
        if scale > 0.0 {
            command.arg("--length-scale").arg(scale.to_string());
        }
    }
    command
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::piped());

    let mut child = command
        .spawn()
        .map_err(|e| to_napi_err("EIO", &format!("could not start Piper: {e}")))?;

    if let Some(stdin) = child.stdin.as_mut() {
        let _ = stdin.write_all(spoken.as_bytes());
    }
    drop(child.stdin.take());

    {
        let mut guard = RUNNING.lock().map_err(|_| to_napi_err("EIO", "speech state is broken"))?;
        *guard = Some(child);
    }
    let slot = RUNNING.clone();
    watch_child(slot);

    // The watcher may have cleared the slot already; ask the process directly.
    let status = {
        let mut guard = RUNNING.lock().map_err(|_| to_napi_err("EIO", "speech state is broken"))?;
        match guard.as_mut() {
            Some(child) => Some(child.wait().map_err(|e| to_napi_err("EIO", &e.to_string()))?),
            // The speech was stopped on purpose.
            None => None,
        }
    };

    if let Some(status) = status {
        if !status.success() {
            let _ = std::fs::remove_file(&out_path);
            return Err(to_napi_err("EIO", "Piper could not synthesise the text"));
        }
    }
    if !out_path.is_file() {
        return Err(to_napi_err("EIO", "Piper produced no audio"));
    }

    Ok(out_path.to_string_lossy().to_string())
}

/// Stop the speech that is currently playing.
#[napi]
pub fn stop_speaking() -> bool {
    let Ok(mut guard) = RUNNING.lock() else {
        return false;
    };
    let Some(child) = guard.as_mut() else {
        return false;
    };
    let stopped = child.kill().is_ok();
    *guard = None;
    stopped
}

/// Delete generated audio that is no longer needed.
#[napi]
pub fn clear_speech_cache() -> f64 {
    let dir = std::env::temp_dir().join("delta-speech");
    let mut removed = 0.0;
    if let Ok(entries) = std::fs::read_dir(&dir) {
        for entry in entries.flatten() {
            if std::fs::remove_file(entry.path()).is_ok() {
                removed += 1.0;
            }
        }
    }
    removed
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strips_markdown_decoration() {
        let spoken = markdown_to_speech("# Title\n\nSome **bold** and _italic_ text.");
        assert_eq!(spoken, "Title\nSome bold and italic text.");
    }

    #[test]
    fn resolves_wikilinks_to_their_label() {
        let spoken = markdown_to_speech("See [[Notes|the notes]] and [[Other]].");
        assert_eq!(spoken, "See the notes and Other.");
    }

    #[test]
    fn drops_code_fences_but_keeps_the_code() {
        let spoken = markdown_to_speech("Text\n\n```rust\nfn main() {}\n```\n\nMore");
        assert_eq!(spoken, "Text\nfn main() {}\nMore");
    }

    #[test]
    fn removes_task_markers() {
        let spoken = markdown_to_speech("- [ ] Write it\n- [x] Done");
        assert_eq!(spoken, "Write it\nDone");
    }

    #[test]
    fn a_real_note_reads_as_plain_prose() {
        // The note Delta ships with, so a regression in the cleaner shows up
        // as "hash hash" or "dash" being spoken out loud.
        let note = "# Welcome to Delta\n\
             \n\
             Delta keeps **Markdown notes**, tasks, a calendar and drawings in one place, on\n\
             your own disk. Everything here is a plain file you can read anywhere.\n\
             \n\
             ## Try it out\n\
             \n\
             - [x] Open a note and press **Read aloud** to hear it\n\
             - [ ] Drag a task onto the calendar\n\
             - [ ] Turn on [[Drawings]] sync in Settings to keep the vault in step\n\
             \n\
             > Notes stay ordinary `.md` files. Nothing is locked away.\n";

        let spoken = markdown_to_speech(note);

        for noise in ["#", "**", "- ", "> ", "[x]", "[ ]", "`"] {
            assert!(
                !spoken.contains(noise),
                "the spoken text still contains {noise:?}: {spoken:?}"
            );
        }
        assert!(spoken.contains("Welcome to Delta"));
        assert!(spoken.contains("Markdown notes"));
        assert!(spoken.contains("Open a note and press Read aloud"));
        assert!(spoken.contains("Turn on Drawings sync"));
        assert!(spoken.contains("Notes stay ordinary .md files"));
    }

    #[test]
    fn reads_table_rows_without_pipes() {
        let spoken = markdown_to_speech("| Name | Size |\n| --- | --- |\n| a.txt | 12 |");
        assert!(!spoken.contains('|'));
        assert!(!spoken.contains("---"));
        assert!(spoken.contains("Name, Size"));
        assert!(spoken.contains("a.txt, 12"));
    }

    #[test]
    fn drops_frontmatter() {
        let spoken = markdown_to_speech(
            "---\ntags: [idea, project]\ncreated: 2026-01-01\n---\n\n# Title\n\nThe body.",
        );
        assert!(!spoken.contains("tags"));
        assert!(!spoken.contains("created"));
        assert!(!spoken.contains("---"));
        assert_eq!(spoken, "Title\nThe body.");
    }

    #[test]
    fn keeps_a_lone_rule_as_a_rule() {
        // A note that starts with a divider but has no frontmatter should not
        // swallow the rest of the note.
        let spoken = markdown_to_speech("---\n\nThe body stays.");
        assert_eq!(spoken, "The body stays.");
    }

    #[test]
    fn drops_horizontal_rules() {
        let spoken = markdown_to_speech("Above\n\n---\n\nBelow");
        assert_eq!(spoken, "Above\nBelow");
    }

    #[test]
    fn drops_inline_tags() {
        let spoken = markdown_to_speech("A thought #idea worth keeping.");
        assert_eq!(spoken, "A thought worth keeping.");
    }

    #[test]
    fn keeps_underscores_inside_words() {
        let spoken = markdown_to_speech("The file snake_case_name stays readable.");
        assert!(spoken.contains("snake_case_name"));
    }

    #[test]
    fn drops_link_definitions() {
        let spoken = markdown_to_speech("See the [manual][m].\n\n[m]: https://example.com");
        assert_eq!(spoken, "See the manual.");
    }

    #[test]
    fn plain_text_is_left_alone() {
        // Text that is already rendered prose must not be touched again.
        let spoken = plain_to_speech("A sentence with  double spaces.\n\nAnother one.");
        assert_eq!(spoken, "A sentence with double spaces.\nAnother one.");
    }
}
