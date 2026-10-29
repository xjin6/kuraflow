// Resolve prices at read time. Never materialize derived prices into saved quotes.
const emptyQuote = () => ({price:null,taxBasis:'unspecified',taxRate:null,source:null,kind:'unquoted'});
const validPrice = value => typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= Number.MAX_SAFE_INTEGER / 100;
const factor = row => typeof row?.perBase === 'number' && Number.isFinite(row.perBase) && row.perBase > 0 ? row.perBase : null;
const copyQuote = quote => ({...emptyQuote(),...JSON.parse(JSON.stringify(quote))});
const roundedPrice = value => Math.round((value + Number.EPSILON) * 100) / 100;

export function resolveUnitPrice(units, quotes, unit) {
  const direct = quotes?.[unit];
  if (validPrice(direct?.price)) return copyQuote(direct);
  const target = units.find(row => row.unit === unit), targetFactor = factor(target);
  if (!targetFactor) return emptyQuote();
  const candidates = units.flatMap(row => {
    const quote = quotes?.[row.unit], sourceFactor = factor(row);
    if (row.unit === unit || !sourceFactor || !validPrice(quote?.price)) return [];
    const ratio = sourceFactor / targetFactor, price = roundedPrice(quote.price * ratio);
    return validPrice(price) ? [{unit:row.unit,quote:copyQuote(quote),price,ratio}] : [];
  });
  const source = candidates[0];
  if (!source) return emptyQuote();
  // Multiple manually priced units may contain bulk discounts or different tax
  // bases. Do not choose arbitrarily when they imply different target prices.
  if (candidates.some(row => row.price !== source.price || row.quote.taxBasis !== source.quote.taxBasis || row.quote.taxRate !== source.quote.taxRate)) return emptyQuote();
  return {...source.quote,price:source.price,kind:'derived',derivedFrom:{unit:source.unit,price:source.quote.price,ratio:source.ratio}};
}
