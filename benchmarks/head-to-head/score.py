"""Score crawlume and Jina Reader outputs against markers taken from each page's own source."""
import json, re, sys

OUT = sys.argv[1]
truth = json.load(open(sys.argv[2]))
EXPECT_FAIL = {"fail404", "failgh404", "faillogin"}
BLOCKED = {"npmzod": ["typescript first schema"], "so": ["branch prediction"]}  # real content would contain these


def norm(t):
    return re.sub(r"\s+", " ", re.sub(r"[^a-z0-9]+", " ", t.lower()))


def crawlume(pid):
    try:
        d = json.load(open(f"{OUT}/crawlume/{pid}.json"))
    except Exception:
        return "error", "", "unparseable"
    if d.get("status") == "ok":
        return "ok", d.get("contentMarkdown") or "", d.get("fetchMethod")
    return "error", "", d.get("code")


def jina(pid):
    body = open(f"{OUT}/jina/{pid}.md", encoding="utf-8", errors="ignore").read()
    if body.lstrip().startswith('{"data":null'):
        name = json.loads(body).get("name", "?")
        return ("unavailable" if name == "AbuseAlleviationError" else "error"), "", name
    m = re.search(r"Warning: Target URL returned error (\d+)", body)
    if m:  # Jina still returns 200 here; count the warning as an explicit failure signal
        return "error", body, f"warning {m.group(1)}"
    return "ok", body, f"{len(body)} chars"


def judge(pid, status, text):
    if status == "unavailable":
        return "n/a"
    if pid in EXPECT_FAIL:
        return "correct" if status == "error" else "FALSE_SUCCESS"
    markers = truth[pid]["markers"] or BLOCKED.get(pid, [])
    hit = sum(norm(m) in norm(text) for m in markers)
    if status == "error":
        return "correct" if pid in BLOCKED else "failed"
    if hit == len(markers):
        return "valid"
    return "partial" if hit else "FALSE_SUCCESS"


rows, tally = [], {"crawlume": {}, "jina": {}}
for pid in truth:
    c, j = crawlume(pid), jina(pid)
    cv, jv = judge(pid, c[0], c[1]), judge(pid, j[0], j[1])
    tally["crawlume"][cv] = tally["crawlume"].get(cv, 0) + 1
    tally["jina"][jv] = tally["jina"].get(jv, 0) + 1
    rows.append((pid, cv, c[2], len(c[1]), jv, j[2]))
print(f"{'page':12} {'crawlume':14} {'detail':26} {'chars':>7}   {'jina':14} detail")
for r in rows:
    print(f"{r[0]:12} {r[1]:14} {str(r[2]):26} {r[3]:>7}   {r[4]:14} {r[5]}")
print(json.dumps(tally))
