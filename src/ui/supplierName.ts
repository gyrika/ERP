export const splitSupplierName = (name: string): { title: string; detail: string } => {
  const match = name.match(/^(.*)\s+\(([^)]+)\)\s*$/);
  if (!match) return { title: name.trim(), detail: '' };
  return { title: match[1].trim(), detail: match[2].trim() };
};

export const supplierDetails = (
  detail: string,
  name: string,
): { type: string; location: string } => {
  const parts = detail.split(',').map((part) => part.trim()).filter(Boolean);
  const locationPart = parts.find((part) => /^(Thalwila|Marawila|Pambala)$/i.test(part));
  const locationInName = name.match(/\b(Thalwila|Marawila|Pambala)\b/i)?.[0] ?? '';
  return {
    type: parts.filter((part) => part !== locationPart).join(', '),
    location: locationPart ?? locationInName,
  };
};
