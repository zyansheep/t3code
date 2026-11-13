/** A USD amount at a glance: cents below $100, whole dollars above, and a floor for tiny ones. */
export function formatCostUsd(amount: number): string {
  if (amount > 0 && amount < 0.01) return "<$0.01";
  return amount < 100 ? `$${amount.toFixed(2)}` : `$${Math.round(amount).toLocaleString("en-US")}`;
}
