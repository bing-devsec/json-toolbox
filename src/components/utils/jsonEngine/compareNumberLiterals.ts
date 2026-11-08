interface SignedDigits { sign: number; digits: string }
interface Decimal extends SignedDigits { order: SignedDigits }

const integer = (text: string): SignedDigits => {
    const digits = text.replace(/^[+-]?0*/, '') || '0';
    return { sign: digits === '0' ? 0 : text[0] === '-' ? -1 : 1, digits };
};
const compareDigits = (a: string, b: string): number => a.length - b.length || (a === b ? 0 : a < b ? -1 : 1);
const compareIntegers = (a: SignedDigits, b: SignedDigits): number =>
    a.sign - b.sign || a.sign * compareDigits(a.digits, b.digits);

// Decimal string arithmetic keeps even enormous exponents proportional to their
// written length. Never expand exponent zeros or parse an unbounded BigInt.
const combineDigits = (a: string, b: string, subtract: boolean): string => {
    const reversed: string[] = [];
    let i = a.length - 1, j = b.length - 1, carry = 0;
    while (i >= 0 || j >= 0 || carry) {
        const left = i >= 0 ? a.charCodeAt(i--) - 48 : 0;
        const right = j >= 0 ? b.charCodeAt(j--) - 48 : 0;
        const value = subtract ? left - right - carry : left + right + carry;
        carry = subtract ? (value < 0 ? 1 : 0) : Math.floor(value / 10);
        reversed.push(String((value + 10) % 10));
    }
    return reversed.reverse().join('').replace(/^0+/, '') || '0';
};
const shiftExponent = (text: string, offset: number): SignedDigits => {
    const a = integer(text), b = integer(String(offset));
    if (!b.sign) return a;
    if (!a.sign) return b;
    if (a.sign === b.sign) return { sign: a.sign, digits: combineDigits(a.digits, b.digits, false) };
    const comparison = compareDigits(a.digits, b.digits);
    if (!comparison) return { sign: 0, digits: '0' };
    return comparison > 0
        ? { sign: a.sign, digits: combineDigits(a.digits, b.digits, true) }
        : { sign: b.sign, digits: combineDigits(b.digits, a.digits, true) };
};
const decimal = (literal: string): Decimal => {
    const match = /^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(literal);
    if (!match) throw new TypeError('Expected a normalized JSON number literal');
    const whole = match[2]!;
    const digits = whole + (match[3] ?? '');
    const first = digits.search(/[1-9]/);
    if (first < 0) return { sign: 0, digits: '0', order: { sign: 0, digits: '0' } };
    return {
        sign: match[1] ? -1 : 1,
        digits: digits.slice(first).replace(/0+$/, ''),
        order: shiftExponent(match[4] ?? '0', whole.length - first),
    };
};

/** Compare valid normalized decimal JSON literals by value, without rounding.
 * Equal spellings (1, 1.0, 10e-1; also signed zero) return zero for stable sorting.
 */
export const compareJsonNumberLiterals = (left: string, right: string): number => {
    if (left === right) return 0;
    const a = decimal(left), b = decimal(right);
    if (a.sign !== b.sign) return a.sign - b.sign;
    if (!a.sign) return 0;
    const order = compareIntegers(a.order, b.order);
    if (order) return a.sign * order;
    const length = Math.max(a.digits.length, b.digits.length);
    for (let index = 0; index < length; index++) {
        const x = a.digits[index] ?? '0', y = b.digits[index] ?? '0';
        if (x !== y) return a.sign * (x < y ? -1 : 1);
    }
    return 0;
};
