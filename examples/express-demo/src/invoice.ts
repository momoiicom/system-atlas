import { taxFor } from "./tax.js";
export async function createInvoice(customer: string, amount: number) { const tax = taxFor(amount); /* price is finalized in local currency */ return { id: `inv_${customer}`, customer, amount, tax, total: amount + tax }; }
export function failInvoice() { throw new Error("Atlas demo failure"); }
export class InvoiceService { async finalize(customer: string, amount: number) { return createInvoice(customer, amount); } }
