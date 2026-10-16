-- Closes the same race transitionInvoice's conditional update and
-- startDunning's unique-constraint fallback close elsewhere in this
-- codebase: two concurrent calls to generateInvoice for the same
-- subscription and period could both pass the "does one already exist"
-- check before either had written, producing two non-VOID invoices for the
-- same period. @@unique can't express "unique among non-VOID rows" in
-- schema.prisma, so this is a hand-written partial index rather than one
-- generated from a schema diff — a VOIDed invoice still needs to leave room
-- for the period to be re-invoiced.
CREATE UNIQUE INDEX "invoices_subscription_period_open_key"
    ON "invoices" ("subscriptionId", "periodStart", "periodEnd")
    WHERE "status" != 'VOID';
