import express from "express";
import { InvoiceService, failInvoice } from "./invoice.js";
import { productName } from "./metadata.js";
const app = express(); const invoices = new InvoiceService();
export async function handleInvoice(request: express.Request, response: express.Response) { response.json(await invoices.finalize(request.params.customer, 42)); }
app.get("/invoice/fail", () => failInvoice());
app.get("/invoice/:customer", handleInvoice);
app.listen(4310, "127.0.0.1", () => console.log(productName + " listening on http://127.0.0.1:4310"));
