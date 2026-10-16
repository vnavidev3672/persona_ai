"""Static quality gate. Returns (violations, weak_test_names). Violations block the suite."""
import ast, re

GENERIC = re.compile(r"^(test_?)?(case|test|t|example|scenario|check)_?\d*$", re.I)
VAGUE_BASES = {"Exception", "BaseException"}

def _bad_name(n: str, min_len: int) -> bool:
    base = n[5:] if n.startswith("test_") else n
    return bool(GENERIC.match(n) or GENERIC.match(base)) or len(base) < min_len

# ---------------- Python ----------------
def _weak_assert(a: ast.Assert) -> bool:
    t = a.test
    if isinstance(t, ast.Constant):
        return True
    if (isinstance(t, ast.Compare) and len(t.ops) == 1 and isinstance(t.ops[0], ast.IsNot)
            and isinstance(t.comparators[0], ast.Constant) and t.comparators[0].value is None):
        return True
    if isinstance(t, (ast.Name, ast.Attribute)):
        return True
    return isinstance(t, ast.Call) and getattr(t.func, "id", None) in ("isinstance", "callable", "hasattr")

def _has_strong(fn) -> bool:
    for n in ast.walk(fn):
        if isinstance(n, ast.Assert) and not _weak_assert(n):
            return True
        if isinstance(n, ast.Call) and isinstance(n.func, ast.Attribute) and (
                n.func.attr in ("raises", "warns") or n.func.attr.startswith("assert")):
            return True
    return False

def _check_py(code, tests):
    try:
        tt = ast.parse(tests)
    except SyntaxError as e:
        return [f"Test file has a syntax error: {e}"], []
    v, weak = [], []
    fns = [n for n in ast.walk(tt) if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef)) and n.name.startswith("test")]
    if len(fns) < 4:
        v.append(f"Only {len(fns)} tests; at least 4 are required.")
    for f in fns:
        if _bad_name(f.name, 10):
            v.append(f"Test name '{f.name}' is not descriptive.")
        if not _has_strong(f):
            weak.append(f.name)
    if weak:
        v.append("Tests without a meaningful assertion on a specific value or error: " + ", ".join(weak))
    try:
        ct = ast.parse(code)
    except SyntaxError:
        return v, weak
    defined, classes, raised = set(), {}, set()
    for n in ct.body:
        if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            defined.add(n.name)
            if isinstance(n, ast.ClassDef):
                classes[n.name] = [getattr(b, "id", getattr(b, "attr", "")) for b in n.bases]
        elif isinstance(n, ast.Assign):
            defined.update(t.id for t in n.targets if isinstance(t, ast.Name))
        elif isinstance(n, (ast.Import, ast.ImportFrom)):
            defined.update((a.asname or a.name).split(".")[0] for a in n.names)
    imported, imports_subject = set(), False
    for n in ast.walk(tt):
        if isinstance(n, ast.ImportFrom) and n.module == "subject":
            imports_subject = True
            imported.update(a.name for a in n.names)
        elif isinstance(n, ast.Import) and any(a.name == "subject" for a in n.names):
            imports_subject = True
        elif isinstance(n, ast.Attribute) and isinstance(n.value, ast.Name) and n.value.id == "subject":
            imported.add(n.attr)
    if not imports_subject:
        v.append("Tests must import the code under test from the module 'subject'.")
    missing = sorted(x for x in imported if x != "*" and x not in defined)
    if missing:
        v.append("Names used that do not exist in the code: " + ", ".join(missing))
    for n in ast.walk(ct):
        if isinstance(n, ast.Raise) and n.exc is not None:
            e = n.exc.func if isinstance(n.exc, ast.Call) else n.exc
            nm = e.id if isinstance(e, ast.Name) else e.attr if isinstance(e, ast.Attribute) else None
            if nm:
                raised.add(nm)
    for nm in sorted(raised):
        ok, stack = {nm}, [nm]
        while stack:
            for b in classes.get(stack.pop(), []):
                if b and b not in VAGUE_BASES and b not in ok:
                    ok.add(b); stack.append(b)
        if not re.search(r"raises\(\s*\(?[^)]*\b(" + "|".join(map(re.escape, ok)) + r")\b", tests):
            v.append(f"No error-path test (pytest.raises) for {nm}, which the code raises.")
    return v, weak

# ---------------- JavaScript ----------------
def _check_js(code, tests):
    v, weak = [], []
    ms = list(re.finditer(r"\b(?:test|it)\(\s*(['\"`])(.+?)\1", tests))
    if len(ms) < 4:
        v.append(f"Only {len(ms)} tests; at least 4 are required.")
    for i, m in enumerate(ms):
        name = m.group(2)
        body = tests[m.end(): ms[i + 1].start() if i + 1 < len(ms) else len(tests)]
        if _bad_name(name, 12) or " " not in name.strip():
            v.append(f"Test name '{name}' is not descriptive.")
        calls = re.findall(r"assert(?:\.(\w+))?\(([^\n]*)", body)
        strong = False
        for meth, args in calls:
            if meth == "ok" or meth == "":
                if re.search(r"===|!==|==|>=|<=|>|<|\.includes\(|\.test\(", args) and "true" != args.strip(" );"):
                    strong = True
            elif meth in ("notStrictEqual", "notEqual") and re.search(r"\b(null|undefined)\b", args):
                continue
            elif meth:
                strong = True
        if not strong:
            weak.append(name)
    if weak:
        v.append("Tests without a meaningful assertion: " + "; ".join(weak))
    m = re.search(r"(?:require\(\s*['\"]\./subject(?:\.m?js)?['\"]\s*\)|from\s+['\"]\./subject\.m?js['\"])", tests)
    if not m:
        v.append("Tests must import the code under test from './subject'.")
    for grp in re.findall(r"(?:const|let)\s*\{([^}]*)\}\s*=\s*require\(\s*['\"]\./subject|import\s*\{([^}]*)\}\s*from\s*['\"]\./subject", tests):
        for nm in [x.split(":")[0].split(" as ")[0].strip() for x in (grp[0] or grp[1]).split(",") if x.strip()]:
            if not re.search(rf"\b{re.escape(nm)}\b", code):
                v.append(f"Name '{nm}' does not exist in the code.")
    for nm in sorted(set(re.findall(r"throw\s+new\s+(\w+)", code))):
        if not (re.search(r"assert\.(throws|rejects)", tests) and re.search(rf"\b{nm}\b", tests)):
            v.append(f"No error-path test (assert.throws/rejects) for {nm}, which the code throws.")
    return v, weak

def check(language, code, tests):
    return _check_py(code, tests) if language == "python" else _check_js(code, tests)
