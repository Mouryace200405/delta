use crate::db::EventRecord;
use chrono::{Datelike, Duration, NaiveDate, NaiveDateTime, TimeZone, Timelike, Utc};
use chrono_tz::Tz;
use std::str::FromStr;

/// Produce an RFC 5545 calendar containing the given events.
pub fn export_ics(events: &[EventRecord], calendar_name: &str) -> String {
    let mut out = String::new();
    out.push_str("BEGIN:VCALENDAR\r\n");
    out.push_str("VERSION:2.0\r\n");
    out.push_str("PRODID:-//Delta//Local First Knowledge Base//EN\r\n");
    out.push_str("CALSCALE:GREGORIAN\r\n");
    out.push_str(&format!(
        "X-WR-CALNAME:{}\r\n",
        escape_text(calendar_name)
    ));
    out.push_str("METHOD:PUBLISH\r\n");

    let dtstamp = Utc::now().format("%Y%m%dT%H%M%SZ").to_string();
    for event in events {
        out.push_str("BEGIN:VEVENT\r\n");
        out.push_str(&fold_line(&format!("UID:{}", event.id)));
        out.push_str(&fold_line(&format!("DTSTAMP:{}", dtstamp)));
        out.push_str(&fold_line(&format!("SUMMARY:{}", escape_text(&event.title))));
        if !event.description.is_empty() {
            out.push_str(&fold_line(&format!(
                "DESCRIPTION:{}",
                escape_text(&event.description)
            )));
        }
        if let Some(location) = &event.location {
            if !location.is_empty() {
                out.push_str(&fold_line(&format!("LOCATION:{}", escape_text(location))));
            }
        }
        if event.all_day {
            let start_date = utc_to_date(event.start_utc as i64);
            let end_date = utc_to_date(event.end_utc as i64);
            out.push_str(&fold_line(&format!("DTSTART;VALUE=DATE:{}", start_date)));
            out.push_str(&fold_line(&format!("DTEND;VALUE=DATE:{}", end_date)));
        } else {
            out.push_str(&fold_line(&format!(
                "DTSTART:{}",
                utc_stamp(event.start_utc as i64)
            )));
            out.push_str(&fold_line(&format!(
                "DTEND:{}",
                utc_stamp(event.end_utc as i64)
            )));
        }
        if let Some(rrule) = &event.rrule {
            if !rrule.trim().is_empty() {
                out.push_str(&fold_line(&format!("RRULE:{}", rrule.trim())));
            }
        }
        if !event.exdates.is_empty() {
            let stamps: Vec<String> = event
                .exdates
                .iter()
                .filter_map(|s| s.parse::<f64>().ok())
                .map(|ms| utc_stamp(ms as i64))
                .collect();
            if !stamps.is_empty() {
                out.push_str(&fold_line(&format!("EXDATE:{}", stamps.join(","))));
            }
        }
        out.push_str("END:VEVENT\r\n");
    }
    out.push_str("END:VCALENDAR\r\n");
    out
}

/// Escape text for an iCalendar property value.
fn escape_text(value: &str) -> String {
    value
        .replace('\\', "\\\\")
        .replace(';', "\\;")
        .replace(',', "\\,")
        .replace('\n', "\\n")
}

/// Format epoch milliseconds as a UTC calendar stamp.
pub fn utc_stamp(ms: i64) -> String {
    let dt = Utc
        .timestamp_millis_opt(ms)
        .single()
        .unwrap_or_else(|| Utc.timestamp_opt(0, 0).unwrap());
    dt.format("%Y%m%dT%H%M%SZ").to_string()
}

/// Format epoch milliseconds as a local date.
pub fn utc_to_date(ms: i64) -> String {
    let dt = Utc
        .timestamp_millis_opt(ms)
        .single()
        .unwrap_or_else(|| Utc.timestamp_opt(0, 0).unwrap());
    dt.format("%Y%m%d").to_string()
}

/// Fold a content line to 75 octets as required by RFC 5545.
fn fold_line(line: &str) -> String {
    let bytes = line.as_bytes();
    if bytes.len() <= 75 {
        return format!("{}\r\n", line);
    }
    let mut out = String::new();
    let mut start = 0usize;
    let mut limit = 75usize;
    while start < bytes.len() {
        let end = (start + limit).min(bytes.len());
        // Do not split a UTF-8 character across the fold.
        let mut cut = end;
        while cut > start && cut < bytes.len() && (bytes[cut] & 0xC0) == 0x80 {
            cut -= 1;
        }
        if cut == start {
            cut = end;
        }
        if start == 0 {
            out.push_str(std::str::from_utf8(&bytes[start..cut]).unwrap_or(""));
        } else {
            out.push_str("\r\n ");
            out.push_str(std::str::from_utf8(&bytes[start..cut]).unwrap_or(""));
        }
        start = cut;
        limit = 74;
    }
    out.push_str("\r\n");
    out
}

/// A parsed calendar event.
pub struct ParsedEvent {
    pub uid: Option<String>,
    pub summary: String,
    pub description: String,
    pub location: Option<String>,
    pub start: i64,
    pub end: i64,
    pub all_day: bool,
    pub rrule: Option<String>,
    pub exdates: Vec<String>,
}

/// Parse an iCalendar document into events.
pub fn parse_ics(text: &str) -> Vec<ParsedEvent> {
    let unfolded = unfold(text);
    let mut events = Vec::new();
    let mut current: Option<Vec<(String, String)>> = None;

    for line in unfolded {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        if trimmed.eq_ignore_ascii_case("BEGIN:VEVENT") {
            current = Some(Vec::new());
            continue;
        }
        if trimmed.eq_ignore_ascii_case("END:VEVENT") {
            if let Some(props) = current.take() {
                if let Some(event) = build_event(&props) {
                    events.push(event);
                }
            }
            continue;
        }
        if let Some(props) = current.as_mut() {
            if let Some((name, value)) = split_property(trimmed) {
                props.push((name, value));
            }
        }
    }
    events
}

/// Unfold continuation lines.
fn unfold(text: &str) -> Vec<String> {
    let mut lines: Vec<String> = Vec::new();
    for raw in text.replace("\r\n", "\n").replace('\r', "\n").split('\n') {
        if let Some(rest) = raw.strip_prefix(' ') {
            if let Some(last) = lines.last_mut() {
                last.push_str(rest);
                continue;
            }
        }
        if let Some(rest) = raw.strip_prefix('\t') {
            if let Some(last) = lines.last_mut() {
                last.push_str(rest);
                continue;
            }
        }
        lines.push(raw.to_string());
    }
    lines
}

/// Split `NAME;PARAM=VAL:value` into its name and raw value.
fn split_property(line: &str) -> Option<(String, String)> {
    let idx = line.find(':')?;
    let head = &line[..idx];
    let value = line[idx + 1..].to_string();
    let name = head.split(';').next().unwrap_or(head).trim().to_uppercase();
    let params: Vec<&str> = head.split(';').skip(1).collect();
    let has_tzid = params
        .iter()
        .any(|p| p.trim().to_uppercase().starts_with("TZID="));
    let value_type = params
        .iter()
        .find_map(|p| {
            let mut parts = p.splitn(2, '=');
            let key = parts.next()?.trim().to_uppercase();
            if key == "VALUE" {
                Some(parts.next().unwrap_or("").trim().to_uppercase())
            } else {
                None
            }
        })
        .unwrap_or_default();

    let payload = match value_type.as_str() {
        "DATE" => format!("__DATE__{}", value),
        _ if has_tzid => {
            let tz = params
                .iter()
                .find_map(|p| {
                    let mut parts = p.splitn(2, '=');
                    let key = parts.next()?.trim().to_uppercase();
                    if key == "TZID" {
                        Some(parts.next().unwrap_or("").trim().to_string())
                    } else {
                        None
                    }
                })
                .unwrap_or_default();
            format!("__TZID_{}__{}", tz, value)
        }
        _ => value,
    };
    Some((name, payload))
}

/// Convert a raw date/time value into epoch milliseconds.
fn parse_datetime(raw: &str) -> Option<(i64, bool)> {
    let raw = raw.trim();
    if raw.is_empty() {
        return None;
    }
    if let Some(rest) = raw.strip_prefix("__DATE__") {
        let date = NaiveDate::parse_from_str(rest.trim(), "%Y%m%d").ok()?;
        let midnight = date.and_hms_opt(0, 0, 0)?;
        return Some((midnight.and_utc().timestamp_millis(), true));
    }
    if let Some(rest) = raw.strip_prefix("__TZID_") {
        let (tzid, value) = rest.split_once("__")?;
        let naive = parse_naive(value)?;
        let tz = Tz::from_str(tzid).ok()?;
        let local = tz.from_local_datetime(&naive);
        let resolved = match local {
            chrono::LocalResult::Single(dt) => dt,
            chrono::LocalResult::Ambiguous(a, _) => a,
            chrono::LocalResult::None => {
                // DST gap: shift forward by one hour to land on a valid time.
                tz.from_local_datetime(&(naive + Duration::hours(1)))
                    .single()
                    .unwrap_or_else(|| tz.from_utc_datetime(&naive))
            }
        };
        return Some((resolved.timestamp_millis(), false));
    }
    if let Some(stripped) = raw.strip_suffix('Z') {
        let naive = parse_naive(stripped)?;
        return Some((naive.and_utc().timestamp_millis(), false));
    }
    let naive = parse_naive(raw)?;
    // Floating time — interpret in the machine's local zone.
    let local = chrono::Local
        .from_local_datetime(&naive)
        .single()
        .or_else(|| chrono::Local.from_local_datetime(&naive).earliest())
        .unwrap_or_else(|| chrono::Local.from_utc_datetime(&naive));
    Some((local.timestamp_millis(), false))
}

fn parse_naive(value: &str) -> Option<NaiveDateTime> {
    let value = value.trim();
    for format in [
        "%Y%m%dT%H%M%S",
        "%Y%m%dT%H%M",
        "%Y%m%dT%H",
    ] {
        if let Ok(dt) = NaiveDateTime::parse_from_str(value, format) {
            return Some(dt);
        }
    }
    if let Ok(date) = NaiveDate::parse_from_str(value, "%Y%m%d") {
        return date.and_hms_opt(0, 0, 0);
    }
    None
}

/// Parse an ISO 8601 duration such as `PT1H30M`.
fn parse_duration(value: &str) -> Option<Duration> {
    let value = value.trim();
    let (sign, rest) = match value.strip_prefix('-') {
        Some(rest) => (-1i64, rest),
        None => (1i64, value.strip_prefix('+').unwrap_or(value)),
    };
    let rest = rest.strip_prefix('P')?;
    let mut total = Duration::zero();
    let mut in_time = false;
    let mut number = String::new();
    for ch in rest.chars() {
        match ch {
            'T' => {
                in_time = true;
            }
            '0'..='9' => number.push(ch),
            'W' => {
                let weeks: i64 = number.parse().ok()?;
                total += Duration::weeks(weeks);
                number.clear();
            }
            'D' => {
                let days: i64 = number.parse().ok()?;
                total += Duration::days(days);
                number.clear();
            }
            'H' => {
                let hours: i64 = number.parse().ok()?;
                total += Duration::hours(hours);
                number.clear();
            }
            'M' => {
                let mins: i64 = number.parse().ok()?;
                if in_time {
                    total += Duration::minutes(mins);
                } else {
                    let months = mins;
                    total += Duration::days(months * 30);
                }
                number.clear();
            }
            'S' => {
                let secs: i64 = number.parse().ok()?;
                total += Duration::seconds(secs);
                number.clear();
            }
            _ => return None,
        }
    }
    Some(total * (sign as i32))
}

/// Build an event from the collected properties of one VEVENT.
fn build_event(props: &[(String, String)]) -> Option<ParsedEvent> {
    let mut uid = None;
    let mut summary = String::new();
    let mut description = String::new();
    let mut location = None;
    let mut start: Option<(i64, bool)> = None;
    let mut end: Option<(i64, bool)> = None;
    let mut duration: Option<Duration> = None;
    let mut rrule = None;
    let mut exdates: Vec<String> = Vec::new();

    for (name, value) in props {
        match name.as_str() {
            "UID" => uid = Some(value.trim().to_string()),
            "SUMMARY" => summary = unescape_text(value),
            "DESCRIPTION" => description = unescape_text(value),
            "LOCATION" => location = Some(unescape_text(value)),
            "DTSTART" => start = parse_datetime(value),
            "DTEND" => end = parse_datetime(value),
            "DURATION" => duration = parse_duration(value),
            "RRULE" => rrule = Some(value.trim().to_string()),
            "EXDATE" => {
                for stamp in value.split(',') {
                    if let Some((ms, _)) = parse_datetime(stamp) {
                        exdates.push(ms.to_string());
                    }
                }
            }
            _ => {}
        }
    }

    let (start_ms, all_day) = start?;
    let end_ms = match end {
        Some((ms, _)) => ms,
        None => match duration {
            Some(d) => start_ms + d.num_milliseconds(),
            None if all_day => start_ms + Duration::days(1).num_milliseconds(),
            None => start_ms,
        },
    };

    Some(ParsedEvent {
        uid,
        summary,
        description,
        location,
        start: start_ms,
        end: end_ms,
        all_day,
        rrule,
        exdates,
    })
}

/// Reverse the iCalendar text escaping.
fn unescape_text(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    let mut chars = value.chars();
    while let Some(ch) = chars.next() {
        if ch == '\\' {
            match chars.next() {
                Some('n') => out.push('\n'),
                Some('N') => out.push('\n'),
                Some(',') => out.push(','),
                Some(';') => out.push(';'),
                Some('\\') => out.push('\\'),
                Some(other) => out.push(other),
                None => {}
            }
        } else {
            out.push(ch);
        }
    }
    out
}

/// Convert parsed events into database records.
pub fn parsed_to_records(events: Vec<ParsedEvent>, now_ms: i64) -> Vec<EventRecord> {
    events
        .into_iter()
        .map(|e| EventRecord {
            id: e.uid.unwrap_or_else(|| uuid::Uuid::new_v4().to_string()),
            title: e.summary,
            description: e.description,
            start_utc: e.start as f64,
            end_utc: e.end as f64,
            all_day: e.all_day,
            timezone: "utc".into(),
            rrule: e.rrule,
            exdates: e.exdates,
            color: None,
            location: e.location,
            note_id: None,
            task_id: None,
            created_at: now_ms as f64,
            updated_at: now_ms as f64,
        })
        .collect()
}

/// Start-of-day epoch millis for a date, in the given zone.
pub fn start_of_day_ms(date: NaiveDate, tz: Tz) -> i64 {
    let naive = date.and_hms_opt(0, 0, 0).unwrap();
    match tz.from_local_datetime(&naive) {
        chrono::LocalResult::Single(dt) => dt.timestamp_millis(),
        chrono::LocalResult::Ambiguous(a, _) => a.timestamp_millis(),
        chrono::LocalResult::None => {
            tz.from_utc_datetime(&naive).timestamp_millis()
        }
    }
}

/// Human-friendly local time for an epoch value.
pub fn format_local(ms: i64, tz: Option<Tz>) -> String {
    match tz {
        Some(tz) => match tz.timestamp_millis_opt(ms).single() {
            Some(dt) => dt.format("%Y-%m-%d %H:%M").to_string(),
            None => String::new(),
        },
        None => match Utc.timestamp_millis_opt(ms).single() {
            Some(dt) => dt.format("%Y-%m-%d %H:%M").to_string(),
            None => String::new(),
        },
    }
}

/// Helper used by the calendar layer to build a local midnight timestamp.
pub fn local_midnight(date: NaiveDate) -> i64 {
    let naive = date.and_hms_opt(0, 0, 0).unwrap();
    chrono::Local
        .from_local_datetime(&naive)
        .single()
        .or_else(|| chrono::Local.from_local_datetime(&naive).earliest())
        .unwrap_or_else(|| chrono::Local.from_utc_datetime(&naive))
        .timestamp_millis()
}

/// Weekday helper (Monday = 0) used by the calendar grid.
pub fn weekday_index(date: NaiveDate) -> usize {
    date.weekday().num_days_from_monday() as usize
}

/// Minutes since midnight for a given epoch millis in a zone.
pub fn minutes_of_day(ms: i64, tz: Tz) -> i64 {
    match tz.timestamp_millis_opt(ms).single() {
        Some(dt) => (dt.hour() * 60 + dt.minute()) as i64,
        None => 0,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exports_and_reimports() {
        let event = EventRecord {
            id: "evt-1".into(),
            title: "Team sync".into(),
            description: "Weekly catch up".into(),
            start_utc: 1_800_000_000_000.0,
            end_utc: 1_800_003_600_000.0,
            all_day: false,
            timezone: "utc".into(),
            rrule: Some("FREQ=WEEKLY;COUNT=5".into()),
            exdates: vec![],
            color: None,
            location: Some("Room 3".into()),
            note_id: None,
            task_id: None,
            created_at: 0.0,
            updated_at: 0.0,
        };
        let text = export_ics(std::slice::from_ref(&event), "Test");
        assert!(text.contains("BEGIN:VCALENDAR"));
        assert!(text.contains("SUMMARY:Team sync"));
        assert!(text.contains("RRULE:FREQ=WEEKLY;COUNT=5"));

        let parsed = parse_ics(&text);
        assert_eq!(parsed.len(), 1);
        assert_eq!(parsed[0].summary, "Team sync");
        assert_eq!(parsed[0].location.as_deref(), Some("Room 3"));
        assert_eq!(parsed[0].rrule.as_deref(), Some("FREQ=WEEKLY;COUNT=5"));
        assert_eq!(parsed[0].start, event.start_utc as i64);
    }

    #[test]
    fn parses_all_day_events() {
        let text = "BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:a\r\nSUMMARY:Holiday\r\nDTSTART;VALUE=DATE:20261026\r\nDTEND;VALUE=DATE:20261027\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n";
        let parsed = parse_ics(text);
        assert_eq!(parsed.len(), 1);
        assert!(parsed[0].all_day);
        assert_eq!(parsed[0].end - parsed[0].start, 86_400_000);
    }

    #[test]
    fn parses_timezone_aware_events() {
        let text = "BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:b\r\nSUMMARY:TZ\r\nDTSTART;TZID=America/New_York:20261026T090000\r\nDTEND;TZID=America/New_York:20261026T100000\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n";
        let parsed = parse_ics(text);
        assert_eq!(parsed.len(), 1);
        // 09:00 New York in late October is UTC-4.
        assert_eq!(parsed[0].start, 1_793_019_600_000);
        assert_eq!(parsed[0].end - parsed[0].start, 3_600_000);
    }

    #[test]
    fn unfolds_long_lines() {
        let long = format!("SUMMARY:{}", "x".repeat(200));
        let text = format!(
            "BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:c\r\nDTSTART:20261026T090000Z\r\n{}\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n",
            fold_line(&long).trim_end()
        );
        let parsed = parse_ics(&text);
        assert_eq!(parsed.len(), 1);
        assert_eq!(parsed[0].summary.len(), 200);
    }

    #[test]
    fn events_without_a_start_are_ignored() {
        let text = "BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:z\r\nSUMMARY:No start\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n";
        assert!(parse_ics(text).is_empty());
    }

    #[test]
    fn parses_durations() {
        assert_eq!(parse_duration("PT1H"), Some(Duration::hours(1)));
        assert_eq!(parse_duration("PT30M"), Some(Duration::minutes(30)));
        assert_eq!(parse_duration("P1D"), Some(Duration::days(1)));
    }

    #[test]
    fn escapes_and_unescapes_text() {
        assert_eq!(unescape_text("a\\,b\\;c\\nd"), "a,b;c\nd");
        assert_eq!(escape_text("a,b;c"), "a\\,b\\;c");
    }
}
