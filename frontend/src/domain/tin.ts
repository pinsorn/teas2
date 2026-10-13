export function tinCheckDigit(first12: string): number {
  if (!/^\d{12}$/.test(first12)) throw new Error('first12 must be 12 digits');
  const sum = [...first12].reduce((acc, d, i) => acc + Number(d) * (13 - i), 0);
  return (11 - (sum % 11)) % 10;
}

export function isValidTin(tin: string): boolean {
  return /^\d{13}$/.test(tin) && tinCheckDigit(tin.slice(0, 12)) === Number(tin[12]);
}
