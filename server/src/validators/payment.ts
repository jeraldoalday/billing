import { z } from 'zod';

export const chargeInvoiceSchema = z.object({
  paymentMethodId: z.string().min(1),
});
export type ChargeInvoiceInput = z.infer<typeof chargeInvoiceSchema>;
