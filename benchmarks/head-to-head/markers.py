"""Pick two truth markers per page from the page's own visible source text (not from any tool output)."""
import html, json, re, sys

RAW = sys.argv[1]
MANUAL = {
    # JS-rendered or binary pages: raw HTML does not hold the body text.
    "quotesjs": ["process of our thinking", "it is our choices harry that show what we truly are"],
    "arxivpdf": ["the dominant sequence transduction models", "scaled dot product attention"],
}
SKIP = {"npmzod", "so", "fail404", "failgh404", "faillogin"}


def norm(t: str) -> str:
    return re.sub(r"\s+", " ", re.sub(r"[^a-z0-9]+", " ", t.lower())).strip()


def visible(path: str) -> str:
    t = open(path, encoding="utf-8", errors="ignore").read()
    t = re.sub(r"(?s)<(script|style|nav|header|footer|pre|code)[^>]*>.*?</\1>", " ", t)
    t = re.sub(r"(?s)<a\b[^>]*>.*?</a>", " | ", t)  # keep markers clear of link text
    return html.unescape(re.sub(r"<[^>]+>", " | ", t))


def pick(text: str, at: float) -> str:
    runs = [r.strip() for r in text.split("|")]
    runs = [r for r in runs if len(re.findall(r"[A-Za-z]{2,}", r)) >= 10 and not re.search(r"[{};=<>$]", r)]
    if not runs:
        raise SystemExit("no prose run")
    run = runs[min(int(len(runs) * at), len(runs) - 1)]
    words = norm(run).split()
    return " ".join(words[:7])


out = {}
for line in open(sys.argv[2]):
    pid, url = line.split()
    if pid in MANUAL:
        out[pid] = {"url": url, "markers": MANUAL[pid]}
    elif pid in SKIP:
        out[pid] = {"url": url, "markers": []}
    else:
        text = visible(f"{RAW}/{pid}")
        out[pid] = {"url": url, "markers": [pick(text, 0.25), pick(text, 0.75)]}
json.dump(out, sys.stdout, indent=1)
