import { z } from 'zod';
import { INVOICE_STATUSES } from '../domain/invoice';

export const generateInvoiceSchema = z.object({
  subscriptionId: z.string().min(1),
});
export type GenerateInvoiceInput = z.infer<typeof generateInvoiceSchema>;

export const listInvoicesQuerySchema = z.object({
  customerId: z.string().min(1).optional(),
  subscriptionId: z.string().min(1).optional(),
  status: z.enum(INVOICE_STATUSES).optional(),
});
export type ListInvoicesQuery = z.infer<typeof listInvoicesQuerySchema>;
