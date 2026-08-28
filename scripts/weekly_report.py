#!/usr/bin/env python3
"""Weekly Sando measurement report.

The report is written locally first, then sent through direct SMTP. n8n is
intentionally not read or called.
"""

from __future__ import annotations

import argparse
import html
import json
import os
import smtplib
import ssl
import sys
from datetime import datetime, time, timedelta, timezone
from email.message import EmailMessage
from pathlib import Path
from zoneinfo import ZoneInfo


VOID, BG = "#050305", "#0a0608"
S1, S2 = "#120c10", "#180f14"
LINE, FG1, FG2, FG3, FG4 = "#33202a", "#f3eef0", "#c8b9bd", "#8a7a80", "#5a4a50"
CYAN, CYAN_DIM = "#00e5ff", "#062a33"
GREEN, GREEN_DIM = "#00e57e", "#052a1c"
YELLOW, YELLOW_DIM = "#ffd21e", "#2e2606"
RED = "#ff003c"
FONT_MONO = "'JetBrains Mono', ui-monospace, 'SF Mono', Consolas, monospace"
FONT_BODY = "'Chakra Petch', 'Rajdhani', 'Archivo', system-ui, sans-serif"


def load_env(path: Path | None = None) -> dict[str, str]:
    """Read simple KEY=value dotenv content; omit all n8n keys by design."""
    path = path or Path.home() / ".config/task-runner/debrief.env"
    values: dict[str, str] = {}
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except OSError:
        return values
    for line in lines:
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key, value = key.strip(), value.strip()
        if key.startswith("TASK_RUNNER_N8N_"):
            continue
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "'\"":
            value = value[1:-1]
        values[key] = value
    return values


def parse_stamp(value: str) -> datetime:
    stamp = datetime.fromisoformat(value.replace("Z", "+00:00"))
    return stamp.replace(tzinfo=timezone.utc) if stamp.tzinfo is None else stamp


def week_window(now: datetime, zone: ZoneInfo) -> tuple[datetime, datetime]:
    local = now.astimezone(zone)
    start = datetime.combine(local.date() - timedelta(days=local.weekday()), time.min, zone)
    return start, local


def _records(state: dict, start: datetime, end: datetime) -> list[dict]:
    found = []
    for record in state.get("records", []):
        try:
            stamp = parse_stamp(str(record["at"]))
        except (KeyError, TypeError, ValueError):
            continue
        if start.astimezone(timezone.utc) <= stamp <= end.astimezone(timezone.utc):
            found.append(record)
    return found


def _sum(records: list[dict], key: str) -> int:
    return sum(int(record.get(key, 0) or 0) for record in records)


def sando_summary(state: dict, start: datetime, end: datetime) -> dict:
    records = _records(state, start, end)
    known: dict[str, int] = {}
    unknown = 0
    for record in records:
        session = record.get("sessionId")
        if not session:
            unknown += 1
            continue
        known[session] = known.get(session, 0) + int(record.get("estimatedTransformSavingsTokens", 0) or 0)
    saved = _sum(records, "estimatedTransformSavingsTokens")
    input_tokens = _sum(records, "estimatedInputTokens")
    return {
        "saved_tokens": saved,
        "input_tokens": input_tokens,
        "saved_pct": (saved / input_tokens * 100) if input_tokens else None,
        "events": len(records),
        "known_sessions": len(known),
        "unknown_session_events": unknown,
        "average_per_known_session": (sum(known.values()) / len(known)) if known else None,
    }


def _fmt_tokens(value: int | float | None) -> str:
    if value is None:
        return "N/D"
    if isinstance(value, str):
        return value
    return f"{value:,.0f}".replace(",", ".")


def _fmt_pct(value: float | None) -> str:
    return "N/D" if value is None else f"{value:.1f}%"


def build_report(state: dict, now: datetime) -> dict:
    zone = ZoneInfo(state.get("timezone") or "UTC")
    start, end = week_window(now, zone)
    sando = sando_summary(state, start, end)
    return {
        "start": start.date().isoformat(),
        "end": end.date().isoformat(),
        "end_local": end.isoformat(),
        "timezone": str(zone),
        "sando": sando,
    }


def _esc(value: object) -> str:
    return html.escape(str(value), quote=True)


def _row(cells: list[str], header: bool = False) -> str:
    tag = "th" if header else "td"
    color = FG2 if header else FG1
    return "<tr>" + "".join(
        f'<{tag} style="padding:9px 8px;border-bottom:1px solid {LINE};text-align:left;'
        f'font-family:{FONT_MONO};font-size:{"10" if header else "11"}px;'
        f'letter-spacing:.04em;color:{color}">{cell}</{tag}>' for cell in cells
    ) + "</tr>"


def render_html(report: dict, host: str) -> str:
    sando = report["sando"]
    rows = [_row(["MEASURE", "VALUE", "INTERPRETATION"], True)]
    rows.append(_row(["Mechanical reduction", _fmt_tokens(sando["saved_tokens"]), "diagnostic only; not provider cost"]))
    rows.append(_row(["Reduction ratio", _fmt_pct(sando["saved_pct"]), "diagnostic only; not a savings claim"]))
    rows.append(_row(["Observed events", _fmt_tokens(sando["events"]), "PostToolUse observations"]))
    note = (
        "Media meccanica per sessione: " + _fmt_tokens(sando["average_per_known_session"])
        + " (solo sessioni con sessionId; eventi senza sessionId: "
        + _fmt_tokens(sando["unknown_session_events"]) + "). Il costo provider e i turni si leggono dal ledger provider/adaptive."
    )
    return f'''<!doctype html><html><head><meta charset="utf-8"><title>Sando weekly</title></head>
<body data-skin="cyber77" style="margin:0;background:{VOID};color:{FG1};font-family:{FONT_BODY};">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:{BG};">
<tr><td align="center" style="padding:30px 12px"><table role="presentation" width="680" cellpadding="0" cellspacing="0" style="max-width:680px;background:{S1};border:1px solid {LINE}">
<tr><td style="padding:22px 24px;border-bottom:2px solid {CYAN}"><div style="font-family:{FONT_MONO};font-size:11px;letter-spacing:.2em;color:{CYAN}">LOCAL MEASUREMENT · {_esc(host)}</div><div style="margin-top:10px;font-family:{FONT_MONO};font-size:22px;font-weight:700;color:{FG1}">SANDO / WEEKLY REPORT</div><div style="margin-top:8px;font-family:{FONT_MONO};font-size:11px;color:{FG3}">WINDOW {_esc(report["start"])} → {_esc(report["end"])} · {_esc(report["timezone"])}</div></td></tr>
<tr><td style="padding:22px 24px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
<td style="width:33%;padding:14px;background:{CYAN_DIM};border:1px solid {CYAN}"><div style="font-family:{FONT_MONO};font-size:10px;color:{CYAN}">MECHANICAL REDUCTION</div><div style="margin-top:7px;font-family:{FONT_MONO};font-size:22px;color:{FG1}">{_fmt_tokens(sando["saved_tokens"])}</div></td>
<td style="width:33%;padding:14px;background:{S2};border-top:1px solid {LINE};border-bottom:1px solid {LINE}"><div style="font-family:{FONT_MONO};font-size:10px;color:{FG3}">RATE</div><div style="margin-top:7px;font-family:{FONT_MONO};font-size:22px;color:{FG1}">{_fmt_pct(sando["saved_pct"])}</div></td>
<td style="width:33%;padding:14px;background:{S2};border:1px solid {LINE}"><div style="font-family:{FONT_MONO};font-size:10px;color:{FG3}">OBSERVED EVENTS</div><div style="margin-top:7px;font-family:{FONT_MONO};font-size:22px;color:{FG1}">{_fmt_tokens(sando["events"])}</div></td>
</tr></table></td></tr>
<tr><td style="padding:0 24px 16px"><div style="padding:12px 14px;background:{S2};border-left:2px solid {CYAN};font-family:{FONT_MONO};font-size:11px;line-height:1.7;color:{FG2}">{_esc(note)}</div></td></tr>
<tr><td style="padding:0 24px 24px"><div style="margin-bottom:9px;font-family:{FONT_MONO};font-size:11px;letter-spacing:.18em;color:{CYAN}">MECHANICAL DIAGNOSTIC</div><table role="presentation" width="100%" cellpadding="0" cellspacing="0">{"".join(rows)}</table></td></tr>
<tr><td style="padding:14px 24px;border-top:1px solid {LINE};font-family:{FONT_MONO};font-size:10px;line-height:1.6;color:{FG4}">La riduzione meccanica non è una misura di costo. Per un confronto servono contatori provider, classi cache, turni e sessioni control/apply. Generated locally; direct SMTP only.</td></tr>
</table></td></tr></table></body></html>'''


def render_text(report: dict) -> str:
    sando = report["sando"]
    lines = [
        f"SANDO / WEEKLY REPORT — {report['start']} → {report['end']} ({report['timezone']})",
        f"Sando mechanical reduction: {_fmt_tokens(sando['saved_tokens'])} · {_fmt_pct(sando['saved_pct'])} · {sando['events']} events",
        f"Average known session: {_fmt_tokens(sando['average_per_known_session'])}; unknown-session events: {sando['unknown_session_events']}",
        "Provider cost and turn comparison: see the adaptive/provider ledger.",
    ]
    return "\n".join(lines) + "\n"


def _smtp_message(report: dict, text: str, html_body: str, values: dict[str, str]) -> EmailMessage:
    recipient = values.get("TASK_RUNNER_DIGEST_TO", "").strip()
    sender = values.get("TASK_RUNNER_DIGEST_FROM", "").strip() or values.get("TASK_RUNNER_SMTP_USER", "").strip()
    if not recipient or not sender:
        raise RuntimeError("SMTP recipient/sender missing in debrief.env")
    message = EmailMessage()
    message["Subject"] = f"[SANDO] Weekly measurement · {report['start']} → {report['end']}"
    message["From"] = sender
    message["To"] = recipient
    message.set_content(text)
    message.add_alternative(html_body, subtype="html")
    return message


def send_direct(message: EmailMessage, values: dict[str, str]) -> None:
    host, user, password = (values.get(key, "").strip() for key in (
        "TASK_RUNNER_SMTP_HOST", "TASK_RUNNER_SMTP_USER", "TASK_RUNNER_SMTP_PASSWORD"))
    if not host or not user or not password:
        raise RuntimeError("SMTP host/user/password missing in debrief.env")
    try:
        port = int(values.get("TASK_RUNNER_SMTP_PORT", "587"))
    except ValueError as error:
        raise RuntimeError("TASK_RUNNER_SMTP_PORT is invalid") from error
    timeout = float(values.get("TASK_RUNNER_SMTP_TIMEOUT", "30"))
    if port == 465:
        with smtplib.SMTP_SSL(host, port, timeout=timeout, context=ssl.create_default_context()) as smtp:
            smtp.login(user, password)
            smtp.send_message(message)
    else:
        with smtplib.SMTP(host, port, timeout=timeout) as smtp:
            smtp.ehlo()
            smtp.starttls(context=ssl.create_default_context())
            smtp.ehlo()
            smtp.login(user, password)
            smtp.send_message(message)


def _state_path() -> Path:
    configured = os.environ.get("SANDO_METRICS_PATH")
    return Path(configured) if configured else Path.home() / ".local/state/sando/metrics.json"


def _write_report(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    path.write_text(content, encoding="utf-8")
    path.chmod(0o600)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Send Sando's weekly direct-SMTP report")
    parser.add_argument("--metrics", type=Path, default=_state_path())
    parser.add_argument("--env", type=Path, default=Path.home() / ".config/task-runner/debrief.env")
    parser.add_argument("--output", type=Path)
    parser.add_argument("--now", help="ISO timestamp, for deterministic verification")
    parser.add_argument("--dry-run", action="store_true", help="write and print, never send")
    args = parser.parse_args(argv)
    try:
        state = json.loads(args.metrics.read_text(encoding="utf-8")) if args.metrics.exists() else {"timezone": "UTC", "records": []}
        zone = ZoneInfo(state.get("timezone") or "UTC")
        now = parse_stamp(args.now) if args.now else datetime.now(zone)
        report = build_report(state, now)
        html_body = render_html(report, os.uname().nodename)
        output = args.output or Path.home() / ".local/state/sando/reports" / f"weekly-{report['end']}.html"
        _write_report(output, html_body)
        text_body = render_text(report)
        print(text_body, end="")
        print(f"HTML: {output}")
        if args.dry_run:
            return 0
        values = load_env(args.env)
        send_direct(_smtp_message(report, text_body, html_body, values), values)
        print("Delivery: direct SMTP")
        return 0
    except (OSError, json.JSONDecodeError, RuntimeError, ValueError) as error:
        print(f"sando weekly report: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
