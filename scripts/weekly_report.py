#!/usr/bin/env python3
"""Weekly Sando savings report: local metrics + honest tool comparison.

The report is written locally first, then sent through direct SMTP. n8n is
intentionally not read or called.
"""

from __future__ import annotations

import argparse
import html
import json
import os
import shutil
import smtplib
import ssl
import subprocess
import sys
from datetime import date, datetime, time, timedelta, timezone
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
        "provider_saved_tokens": (
            sum(int(r["providerReportedSavingsTokens"]) for r in records
                if r.get("providerReportedSavingsTokens") is not None)
            if any(r.get("providerReportedSavingsTokens") is not None for r in records) else None
        ),
    }


def _rtk_bin() -> str | None:
    configured = os.environ.get("SANDO_RTK_BIN")
    if configured:
        return configured
    local = Path.home() / ".local/bin/rtk"
    return str(local) if local.exists() else shutil.which("rtk")


def rtk_summary(week_start: date) -> dict:
    binary = _rtk_bin()
    if not binary:
        return {"saved_tokens": None, "saved_pct": None, "status": "rtk non trovato"}
    try:
        result = subprocess.run(
            [binary, "gain", "-w", "-f", "json"],
            check=False, capture_output=True, text=True, timeout=20,
        )
        payload = json.loads(result.stdout)
    except (OSError, subprocess.SubprocessError, json.JSONDecodeError):
        return {"saved_tokens": None, "saved_pct": None, "status": "dati RTK non disponibili"}
    row = next((item for item in payload.get("weekly", [])
                if item.get("week_start") == week_start.isoformat()), None)
    if not row:
        return {"saved_tokens": None, "saved_pct": None, "status": "nessun dato RTK per la settimana"}
    return {
        "saved_tokens": int(row.get("saved_tokens", 0)),
        "saved_pct": float(row.get("savings_pct", 0)),
        "status": "stima del ledger RTK; non sommata a Sando",
    }


def _claude_enabled(plugin: str, settings_path: Path) -> bool:
    try:
        settings = json.loads(settings_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return False
    enabled = settings.get("enabledPlugins", {})
    return any(key.startswith(f"{plugin}@") and value is True for key, value in enabled.items())


def tool_comparison(sando: dict, start: datetime, home: Path | None = None) -> list[dict]:
    home = home or Path.home()
    claude_settings = home / ".claude/settings.json"
    honey_active = (home / ".claude/.honey-active").exists() or (home / ".codex/.honey-active").exists()
    caveman_active = _claude_enabled("caveman", claude_settings)
    ponytail_active = _claude_enabled("ponytail", claude_settings)
    rtk = rtk_summary(start.date())
    return [
        {"tool": "Sando", "saved": sando["saved_tokens"], "pct": sando["saved_pct"],
         "status": "stima osservazionale locale", "evidence": "metrics.json"},
        {"tool": "RTK", "saved": rtk["saved_tokens"], "pct": rtk["saved_pct"],
         "status": rtk["status"], "evidence": "rtk gain -w"},
        {"tool": "Honey", "saved": None, "pct": None,
         "status": "attivo; ledger settimanale non disponibile" if honey_active else "non attivo",
         "evidence": "nessun contatore settimanale locale"},
        {"tool": "Caveman", "saved": None, "pct": None,
         "status": "attivo ma senza ledger Sando" if caveman_active else "disattivato",
         "evidence": "stato plugin Claude"},
        {"tool": "Ponytail", "saved": None, "pct": None,
         "status": "attivo ma senza ledger Sando" if ponytail_active else "disattivato",
         "evidence": "stato plugin Claude"},
    ]


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
        "comparison": tool_comparison(sando, start),
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
    rows = [_row(["TOOL", "SAVED TOKENS", "RATE", "EVIDENCE / STATUS"], True)]
    for item in report["comparison"]:
        rows.append(_row([_esc(item["tool"]), _fmt_tokens(item["saved"]), _fmt_pct(item["pct"]),
                          _esc(f'{item["evidence"]} · {item["status"]}')]))
    note = (
        "Media per sessione: " + _fmt_tokens(sando["average_per_known_session"])
        + " (solo sessioni con sessionId; eventi senza sessionId: "
        + _fmt_tokens(sando["unknown_session_events"]) + ")."
    )
    return f'''<!doctype html><html><head><meta charset="utf-8"><title>Sando weekly</title></head>
<body data-skin="cyber77" style="margin:0;background:{VOID};color:{FG1};font-family:{FONT_BODY};">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:{BG};">
<tr><td align="center" style="padding:30px 12px"><table role="presentation" width="680" cellpadding="0" cellspacing="0" style="max-width:680px;background:{S1};border:1px solid {LINE}">
<tr><td style="padding:22px 24px;border-bottom:2px solid {CYAN}"><div style="font-family:{FONT_MONO};font-size:11px;letter-spacing:.2em;color:{CYAN}">PROTOCOL TOKEN-SAVINGS · {_esc(host)}</div><div style="margin-top:10px;font-family:{FONT_MONO};font-size:22px;font-weight:700;color:{FG1}">SANDO / WEEKLY REPORT</div><div style="margin-top:8px;font-family:{FONT_MONO};font-size:11px;color:{FG3}">WINDOW {_esc(report["start"])} → {_esc(report["end"])} · {_esc(report["timezone"])}</div></td></tr>
<tr><td style="padding:22px 24px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
<td style="width:33%;padding:14px;background:{CYAN_DIM};border:1px solid {CYAN}"><div style="font-family:{FONT_MONO};font-size:10px;color:{CYAN}">SANDO SAVED</div><div style="margin-top:7px;font-family:{FONT_MONO};font-size:22px;color:{FG1}">{_fmt_tokens(sando["saved_tokens"])}</div></td>
<td style="width:33%;padding:14px;background:{S2};border-top:1px solid {LINE};border-bottom:1px solid {LINE}"><div style="font-family:{FONT_MONO};font-size:10px;color:{FG3}">RATE</div><div style="margin-top:7px;font-family:{FONT_MONO};font-size:22px;color:{FG1}">{_fmt_pct(sando["saved_pct"])}</div></td>
<td style="width:33%;padding:14px;background:{S2};border:1px solid {LINE}"><div style="font-family:{FONT_MONO};font-size:10px;color:{FG3}">OBSERVED EVENTS</div><div style="margin-top:7px;font-family:{FONT_MONO};font-size:22px;color:{FG1}">{_fmt_tokens(sando["events"])}</div></td>
</tr></table></td></tr>
<tr><td style="padding:0 24px 16px"><div style="padding:12px 14px;background:{S2};border-left:2px solid {CYAN};font-family:{FONT_MONO};font-size:11px;line-height:1.7;color:{FG2}">{_esc(note)}</div></td></tr>
<tr><td style="padding:0 24px 24px"><div style="margin-bottom:9px;font-family:{FONT_MONO};font-size:11px;letter-spacing:.18em;color:{CYAN}">COMPARISON / LOCAL EVIDENCE</div><table role="presentation" width="100%" cellpadding="0" cellspacing="0">{"".join(rows)}</table></td></tr>
<tr><td style="padding:14px 24px;border-top:1px solid {LINE};font-family:{FONT_MONO};font-size:10px;line-height:1.6;color:{FG4}">Sando e RTK usano contatori diversi: le percentuali non sono sommabili. N/D significa che non esiste un ledger locale affidabile per quella settimana. Generated locally; direct SMTP only.</td></tr>
</table></td></tr></table></body></html>'''


def render_text(report: dict) -> str:
    sando = report["sando"]
    lines = [
        f"SANDO / WEEKLY REPORT — {report['start']} → {report['end']} ({report['timezone']})",
        f"Sando: {_fmt_tokens(sando['saved_tokens'])} saved · {_fmt_pct(sando['saved_pct'])} · {sando['events']} events",
        f"Average known session: {_fmt_tokens(sando['average_per_known_session'])}; unknown-session events: {sando['unknown_session_events']}",
        "",
        "TOOL COMPARISON",
    ]
    for item in report["comparison"]:
        lines.append(f"- {item['tool']}: {_fmt_tokens(item['saved'])} · {_fmt_pct(item['pct'])} · {item['status']}")
    return "\n".join(lines) + "\n"


def _smtp_message(report: dict, text: str, html_body: str, values: dict[str, str]) -> EmailMessage:
    recipient = values.get("TASK_RUNNER_DIGEST_TO", "").strip()
    sender = values.get("TASK_RUNNER_DIGEST_FROM", "").strip() or values.get("TASK_RUNNER_SMTP_USER", "").strip()
    if not recipient or not sender:
        raise RuntimeError("SMTP recipient/sender missing in debrief.env")
    message = EmailMessage()
    message["Subject"] = f"[SANDO] Weekly token savings · {report['start']} → {report['end']}"
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
