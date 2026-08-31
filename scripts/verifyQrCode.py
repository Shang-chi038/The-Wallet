"""Independent QR decoder, written from ISO/IEC 18004 rather than from the
encoder. Reads the format info out of the matrix, unmasks, walks the placement
zigzag, de-interleaves the blocks and parses the byte-mode payload."""
import json, sys

ALIGN = {1:[],2:[6,18],3:[6,22],4:[6,26],5:[6,30],6:[6,34],
         7:[6,22,38],8:[6,24,42],9:[6,26,46],10:[6,28,50]}
# level M: ec-per-block, [(blocks, data-per-block), ...]
SPEC = {1:(10,[(1,16)]),2:(16,[(1,28)]),3:(26,[(1,44)]),4:(18,[(2,32)]),
        5:(24,[(2,43)]),6:(16,[(4,27)]),7:(18,[(4,31)]),
        8:(22,[(2,38),(2,39)]),9:(22,[(3,36),(2,37)]),10:(26,[(4,43),(1,44)])}

MASKS = [
    lambda r,c: (r+c)%2==0,
    lambda r,c: r%2==0,
    lambda r,c: c%3==0,
    lambda r,c: (r+c)%3==0,
    lambda r,c: (r//2 + c//3)%2==0,
    lambda r,c: (r*c)%2 + (r*c)%3 == 0,
    lambda r,c: ((r*c)%2 + (r*c)%3)%2==0,
    lambda r,c: ((r+c)%2 + (r*c)%3)%2==0,
]

def reserved_map(size, version):
    res = [[False]*size for _ in range(size)]
    def mark(r,c):
        if 0 <= r < size and 0 <= c < size: res[r][c] = True
    for (orow, ocol) in [(0,0),(0,size-8),(size-8,0)]:
        for r in range(8):
            for c in range(8): mark(orow+r, ocol+c)
    for i in range(size):
        mark(6,i); mark(i,6)
    for cr in ALIGN[version]:
        for cc in ALIGN[version]:
            if (cr==6 and cc==6) or (cr==6 and cc==size-7) or (cr==size-7 and cc==6): continue
            for r in range(-2,3):
                for c in range(-2,3): mark(cr+r, cc+c)
    for i in range(9):
        mark(8,i); mark(i,8)
    for i in range(8):
        mark(8,size-1-i); mark(size-1-i,8)
    if version >= 7:
        for i in range(6):
            for o in range(3):
                mark(size-11+o, i); mark(i, size-11+o)
    return res

def read_format(m, size):
    bits = []
    for i in range(6): bits.append(m[8][i])
    bits += [m[8][7], m[8][8], m[7][8]]
    for i in range(9,15): bits.append(m[14-i][8])
    value = 0
    for i,b in enumerate(bits): value |= b << i
    value ^= 0b101010000010010
    ec = (value >> 13) & 0b11
    mask = (value >> 10) & 0b111
    return ec, mask

def extract(m, size, version, mask):
    res = reserved_map(size, version)
    maskfn = MASKS[mask]
    bits = []
    upward = True
    right = size - 1
    while right >= 1:
        if right == 6: right = 5
        for step in range(size):
            row = size-1-step if upward else step
            for off in range(2):
                col = right - off
                if res[row][col]: continue
                v = m[row][col]
                if not maskfn(row,col): pass
                else: v ^= 1
                bits.append(v)
        upward = not upward
        right -= 2
    return bits

def bits_to_bytes(bits):
    out = []
    for i in range(0, len(bits)//8*8, 8):
        b = 0
        for j in range(8): b = (b<<1) | bits[i+j]
        out.append(b)
    return out

def deinterleave(codewords, version):
    ecper, groups = SPEC[version]
    blocks = []
    for count, per in groups:
        for _ in range(count): blocks.append(per)
    total_data = sum(blocks)
    data_blocks = [[] for _ in blocks]
    idx = 0
    longest = max(blocks)
    for i in range(longest):
        for bi, size_ in enumerate(blocks):
            if i < size_:
                data_blocks[bi].append(codewords[idx]); idx += 1
    return [b for blk in data_blocks for b in blk], total_data

def parse(payload, version):
    bits = []
    for byte in payload:
        for i in range(7,-1,-1): bits.append((byte>>i)&1)
    def take(n):
        nonlocal bits
        v = 0
        for b in bits[:n]: v = (v<<1)|b
        bits = bits[n:]
        return v
    mode = take(4)
    if mode != 0b0100: return None, f"mode {mode:04b} is not byte mode"
    count_bits = 8 if version <= 9 else 16
    length = take(count_bits)
    data = bytes(take(8) for _ in range(length))
    return data, None

ok = True
for entry in json.load(open(sys.argv[1])):
    size, version = entry['size'], entry['version']
    m = [[1 if ch=='1' else 0 for ch in row] for row in entry['rows']]
    ec, mask = read_format(m, size)
    bits = extract(m, size, version, mask)
    codewords = bits_to_bytes(bits)
    data_cw, total_data = deinterleave(codewords, version)
    decoded, err = parse(data_cw[:total_data], version)
    expected = entry['text']
    got = decoded.decode('utf-8', 'replace') if decoded else f"<{err}>"
    match = got == expected
    ok = ok and match
    print(("PASS" if match else "FAIL"), f"v{version} ecLevelBits={ec:02b} mask={mask}", repr(got[:56]))
print("\nALL DECODED CORRECTLY" if ok else "\nMISMATCH")

# ---------------------------------------------------------------------------
# HOW TO RUN THIS
#
#   1. Dump matrices from the encoder (a throwaway vitest file is the simplest
#      way, since the encoder is TypeScript with a path alias):
#
#        QR_DUMP_PATH=/tmp/qr.json npx vitest run <a test that writes the dump>
#
#   2. python3 scripts/verifyQrCode.py /tmp/qr.json
#
# WHY IT EXISTS. The QR encoder in src/core/qr is written rather than installed,
# and testing it against itself would prove nothing. This is a decoder written
# independently, in a different language, from ISO/IEC 18004 -- so agreement
# between the two is real evidence rather than a tautology. Rerun it whenever
# the encoder changes.
# ---------------------------------------------------------------------------
