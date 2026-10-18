-- Closes the same race already fixed for invoices, dunning campaigns, and
-- subscription transitions elsewhere in this codebase: redeemCoupon read
-- for an existing ACTIVE redemption on the subscription, checked it, then
-- created one. Two overlapping calls to redeem a coupon on the same
-- subscription could both find nothing before either wrote, attaching two
-- ACTIVE redemptions to one subscription even though the API only ever
-- means for one to apply at a time.
--
-- @@unique can't express "unique among ACTIVE rows" in schema.prisma, so
-- this is a hand-written partial index rather than one generated from a
-- schema diff — a REMOVED or COMPLETED redemption still needs to leave
-- room for a new one to be redeemed on the same subscription.
CREATE UNIQUE INDEX "coupon_redemptions_subscription_active_key"
    ON "coupon_redemptions" ("subscriptionId")
    WHERE "status" = 'ACTIVE';
