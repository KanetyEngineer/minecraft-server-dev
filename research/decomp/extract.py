import sys, re, os
# usage: extract.py ROOT path/Class.java method1,method2 | path/Class.java *
root = sys.argv[1]
for spec in sys.argv[2:]:
    path, methods = spec.split(':')
    full = os.path.join(root, path)
    if not os.path.exists(full):
        print(f"#### MISSING {path}"); continue
    src = open(full).read()
    print(f"#### {path} [{methods}]")
    if methods == '*':
        print('\n'.join(l for l in src.splitlines() if not l.startswith('import '))); continue
    for m in methods.split(','):
        for mt in re.finditer(r'\n(\t[^\n;{}]*\b' + re.escape(m) + r'\([^;{]*\{)', src):
            i = mt.start(1); depth = 0; j = src.index('{', i)
            k = j
            while True:
                c = src[k]
                if c == '{': depth += 1
                elif c == '}':
                    depth -= 1
                    if depth == 0: break
                k += 1
            print(src[i:k+1]); print()
