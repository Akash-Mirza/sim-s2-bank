const IBAN_PATTERN = /^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/;

function mod97(value: string): number {
  let remainder = 0;
  for (const character of value) {
    const digits = /\d/.test(character) ? character : String(character.charCodeAt(0) - 55); // A -> 10 ... Z -> 35
    for (const digit of digits) {
      remainder = (remainder * 10 + Number(digit)) % 97;
    }
  }
  return remainder;
}

export function computeIbanCheckDigits(countryCode: string, bban: string): string {
  const remainder = mod97(`${bban}${countryCode}00`);
  return String(98 - remainder).padStart(2, "0");
}

/** UAE IBAN: AE + 2 check digits + 3-digit bank code + 16-digit account number. */
export function buildUaeIban(bankCode: string, accountNumber: string): string {
  if (!/^\d{3}$/.test(bankCode)) throw new Error(`invalid UAE bank code: ${bankCode}`);
  if (!/^\d{16}$/.test(accountNumber))
    throw new Error(`invalid UAE account number: ${accountNumber}`);
  const bban = `${bankCode}${accountNumber}`;
  return `AE${computeIbanCheckDigits("AE", bban)}${bban}`;
}

export function isValidIban(input: string): boolean {
  const iban = input.replace(/\s+/g, "").toUpperCase();
  if (!IBAN_PATTERN.test(iban)) return false;
  if (iban.length < 15 || iban.length > 34) return false;
  return mod97(`${iban.slice(4)}${iban.slice(0, 4)}`) === 1;
}

export function isUaeIban(input: string): boolean {
  const iban = input.replace(/\s+/g, "").toUpperCase();
  return iban.startsWith("AE") && iban.length === 23 && isValidIban(iban);
}
