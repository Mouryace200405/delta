use crate::util::file_stem;
use once_cell::sync::Lazy;
use regex::Regex;

static RE_WIKILINK: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"!?\[\[([^\[\]\n]+)\]\]").expect("wikilink regex"));
static RE_MDLINK: Lazy<Regex> =
    Lazy::new(|| Regex::new(r#"!?\[([^\]\n]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)"#).expect("mdlink regex"));
static RE_TAG: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"#([\p{L}\p{N}][\p{L}\p{N}_\-/]*)").expect("tag regex"));
static RE_HEADING: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"(?m)^#{1,6}\s+(.+?)\s*#*\s*$").expect("heading regex"));
static RE_FENCE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"(?ms)^```.*?^```\s*$").expect("fence regex"));
static RE_INLINE_CODE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"`[^`\n]*`").expect("inline code regex"));
static RE_TASK_MARK: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"(?m)^\s*[-*+]\s+\[([ xX])\]\s").expect("task regex"));

/// A link discovered inside a note.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FoundLink {
    /// Display name or path as written.
    pub raw: String,
    /// The link target without alias/heading suffixes.
    pub target: String,
    /// `wikilink` or `markdown`.
    pub kind: String,
    /// True for `![[embed]]` syntax.
    pub embed: bool,
}

/// Shared accessors so other modules can rewrite link syntax.
pub fn wikilink_regex() -> &'static Regex {
    &RE_WIKILINK
}

pub fn markdown_link_regex() -> &'static Regex {
    &RE_MDLINK
}

/// Remove fenced code blocks and inline code so parsing never trips on samples.
pub fn strip_code(content: &str) -> String {
    let without_fences = RE_FENCE.replace_all(content, "");
    RE_INLINE_CODE.replace_all(&without_fences, "").into_owned()
}

/// Title of a note: first Markdown heading if present, otherwise the file stem.
pub fn extract_title(path: &str, content: &str) -> String {
    let stripped = strip_code(content);
    if let Some(cap) = RE_HEADING.captures(&stripped) {
        let heading = cap.get(1).map(|m| m.as_str().trim()).unwrap_or("");
        if !heading.is_empty() {
            return heading.to_string();
        }
    }
    file_stem(path)
}

/// Collect hashtags used as tags, ignoring code samples.
pub fn extract_tags(content: &str) -> Vec<String> {
    let stripped = strip_code(content);
    let mut out: Vec<String> = Vec::new();
    for found in RE_TAG.find_iter(&stripped) {
        // A tag must not follow a word character, another `#` or a `/`; that
        // would catch heading markers and things like `https://x#anchor`.
        if found.start() > 0 {
            let before = stripped[..found.start()].chars().next_back().unwrap_or(' ');
            if before.is_alphanumeric() || before == '_' || before == '#' || before == '/' {
                continue;
            }
        }
        let raw = found.as_str();
        let tag = raw[1..].trim_end_matches(['-', '/']).to_string();
        if tag.is_empty() {
            continue;
        }
        if !out.contains(&tag) {
            out.push(tag);
        }
    }
    out
}

/// Collect wikilinks and Markdown links.
pub fn extract_links(content: &str) -> Vec<FoundLink> {
    let stripped = strip_code(content);
    let mut out: Vec<FoundLink> = Vec::new();

    for cap in RE_WIKILINK.captures_iter(&stripped) {
        let whole = cap.get(0).map(|m| m.as_str()).unwrap_or("");
        let inner = match cap.get(1) {
            Some(m) => m.as_str(),
            None => continue,
        };
        // `[[Target|Alias]]` and `[[Target#Heading]]` both target `Target`.
        let target = inner
            .split('|')
            .next()
            .unwrap_or(inner)
            .split('#')
            .next()
            .unwrap_or(inner)
            .trim()
            .to_string();
        if target.is_empty() {
            continue;
        }
        out.push(FoundLink {
            raw: whole.to_string(),
            target,
            kind: "wikilink".to_string(),
            embed: whole.starts_with("!"),
        });
    }

    for cap in RE_MDLINK.captures_iter(&stripped) {
        let whole = cap.get(0).map(|m| m.as_str()).unwrap_or("");
        let href = match cap.get(2) {
            Some(m) => m.as_str(),
            None => continue,
        };
        // Skip external links and in-page anchors.
        if href.starts_with("http://")
            || href.starts_with("https://")
            || href.starts_with("mailto:")
            || href.starts_with('#')
            || href.starts_with("data:")
        {
            continue;
        }
        let decoded = percent_decode(href);
        let target = decoded
            .split('#')
            .next()
            .unwrap_or(&decoded)
            .trim()
            .to_string();
        if target.is_empty() {
            continue;
        }
        out.push(FoundLink {
            raw: whole.to_string(),
            target,
            kind: "markdown".to_string(),
            embed: whole.starts_with("!"),
        });
    }

    out
}

/// Minimal percent-decoding for link targets.
pub fn percent_decode(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0usize;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hex = std::str::from_utf8(&bytes[i + 1..i + 3]).unwrap_or("");
            match u8::from_str_radix(hex, 16) {
                Ok(byte) => {
                    out.push(byte);
                    i += 3;
                    continue;
                }
                Err(_) => {}
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// A short plain-text excerpt for list views and search results.
pub fn extract_excerpt(content: &str, max_len: usize) -> String {
    let stripped = strip_code(content);
    let mut text = String::new();
    for line in stripped.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        if trimmed.starts_with('#') || trimmed.starts_with("```") {
            continue;
        }
        if !text.is_empty() {
            text.push(' ');
        }
        text.push_str(trimmed);
        if text.len() >= max_len {
            break;
        }
    }
    // Strip remaining inline Markdown emphasis for a clean preview.
    let cleaned = text
        .replace("**", "")
        .replace("__", "")
        .replace('`', "")
        .replace('#', "")
        .trim()
        .to_string();
    if cleaned.chars().count() > max_len {
        let truncated: String = cleaned.chars().take(max_len).collect();
        format!("{}…", truncated.trim_end())
    } else {
        cleaned
    }
}

/// Detect Markdown task-list checkboxes in the body.
pub fn count_tasks(content: &str) -> (usize, usize) {
    let stripped = strip_code(content);
    let mut total = 0usize;
    let mut done = 0usize;
    for cap in RE_TASK_MARK.captures_iter(&stripped) {
        total += 1;
        let mark = cap.get(1).map(|m| m.as_str()).unwrap_or(" ");
        if mark.eq_ignore_ascii_case("x") {
            done += 1;
        }
    }
    (total, done)
}

/// True when the content looks like an Excalidraw scene.
pub fn is_excalidraw(content: &str) -> bool {
    content.contains("\"excalidraw\"") && content.contains("\"elements\"")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn titles_prefer_headings() {
        assert_eq!(extract_title("a/b.md", "# Hello World\nbody"), "Hello World");
        assert_eq!(extract_title("a/b.md", "no heading"), "b");
        assert_eq!(extract_title("a/b.md", "# Ignored\n\n```\n# code fence\n```\n"), "Ignored");
    }

    #[test]
    fn tags_skip_code() {
        let content = "# Heading\n\nreal #tag-one and #nested/tag\n\n```\n#notatag\n```\n";
        let tags = extract_tags(content);
        assert!(tags.contains(&"tag-one".to_string()));
        assert!(tags.contains(&"nested/tag".to_string()));
        assert!(!tags.contains(&"notatag".to_string()));
    }

    #[test]
    fn links_are_parsed() {
        let content = "See [[Alpha]] and [[Beta|Beta Alias]] plus [[Gamma#Section]].\n![img](attachments/pic.png)\n[ext](https://example.com)";
        let links = extract_links(content);
        let targets: Vec<String> = links.iter().map(|l| l.target.clone()).collect();
        assert!(targets.contains(&"Alpha".to_string()));
        assert!(targets.contains(&"Beta".to_string()));
        assert!(targets.contains(&"Gamma".to_string()));
        assert!(targets.contains(&"attachments/pic.png".to_string()));
        assert!(!targets.contains(&"https://example.com".to_string()));
        let embed = links.iter().find(|l| l.target == "attachments/pic.png").unwrap();
        assert!(embed.embed);
    }

    #[test]
    fn percent_decoding_works() {
        assert_eq!(percent_decode("a%20b.png"), "a b.png");
        assert_eq!(percent_decode("plain.png"), "plain.png");
    }

    #[test]
    fn counts_checkboxes() {
        let (total, done) = count_tasks("- [ ] one\n- [x] two\n");
        assert_eq!(total, 2);
        assert_eq!(done, 1);
    }
}
