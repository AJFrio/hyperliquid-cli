import { z } from "zod";
import { ApiError } from "../errors.js";
import { infoUrl, postJson } from "./transport.js";

/**
 * Typed read calls against POST /info.
 *
 * We deliberately use our own transport rather than the SDK's InfoClient so the
 * text/plain error path is handled explicitly and stays unit-testable.
 */

const dec = z.string();
const num = z.number();

export const perpAssetSchema = z.object({
  name: z.string(),
  szDecimals: z.number(),
  maxLeverage: z.number(),
  marginTableId: z.number().optional(),
});
export type PerpAssetParsed = z.infer<typeof perpAssetSchema>;

export const spotPairSchema = z.object({
  name: z.string(),
  index: z.number(),
  tokens: z.tuple([z.number(), z.number()]),
  isCanonical: z.boolean().optional(),
});
export type SpotPairParsed = z.infer<typeof spotPairSchema>;

export const spotTokenSchema = z.object({
  name: z.string(),
  szDecimals: z.number(),
  weiDecimals: z.number(),
  index: z.number(),
  tokenId: z.string(),
  isCanonical: z.boolean().optional(),
});
export type SpotTokenParsed = z.infer<typeof spotTokenSchema>;

export const perpContextSchema = z.object({
  dayNtlVlm: dec.optional(),
  dayBaseVlm: dec.optional(),
  funding: dec.optional(),
  impactPxs: z.array(dec).nullable().optional(),
  markPx: dec.nullable().optional(),
  midPx: dec.nullable().optional(),
  openInterest: dec.optional(),
  oraclePx: dec.nullable().optional(),
  premium: dec.nullable().optional(),
  prevDayPx: dec.optional(),
});
export type PerpContext = z.infer<typeof perpContextSchema>;

export const metaSchema = z.object({
  universe: z.array(perpAssetSchema),
  marginTables: z.unknown().optional(),
  collateralToken: z.unknown().optional(),
});

export const spotMetaSchema = z.object({
  universe: z.array(spotPairSchema),
  tokens: z.array(spotTokenSchema),
});

export const metaAndCtxSchema = z.tuple([metaSchema, z.array(perpContextSchema)]);
export const spotMetaAndCtxSchema = z.tuple([spotMetaSchema, z.array(z.unknown())]);

export const candleSchema = z.object({
  t: num,
  T: num,
  s: z.string(),
  i: z.string(),
  o: dec,
  c: dec,
  h: dec,
  l: dec,
  v: dec,
  n: num,
});
export type Candle = z.infer<typeof candleSchema>;

export const tradeSchema = z.object({
  coin: z.string(),
  side: z.enum(["A", "B"]),
  px: dec,
  sz: dec,
  time: num,
  hash: z.string(),
  tid: num,
  users: z.array(z.string()),
});
export type Trade = z.infer<typeof tradeSchema>;

export const bookLevelSchema = z.object({ px: dec, sz: dec, n: num.optional() });
export const l2BookSchema = z.object({
  coin: z.string(),
  time: num,
  levels: z.tuple([z.array(bookLevelSchema), z.array(bookLevelSchema)]),
});

const venueFundingSchema = z
  .object({
    fundingRate: dec,
    nextFundingTime: num,
    fundingIntervalHours: num.optional(),
  })
  .nullable();

export const predictedFundingSchema = z.array(
  z.tuple([z.string(), z.array(z.tuple([z.string(), venueFundingSchema]))]),
);

export const exchangeStatusSchema = z.object({
  time: num,
  specialStatuses: z.string().nullable().optional(),
});

export interface InfoOptions {
  testnet: boolean;
  fetchImpl?: typeof fetch | undefined;
}

async function info<T>(body: unknown, schema: z.ZodType<T>, opts: InfoOptions): Promise<T> {
  const raw = await postJson(infoUrl(opts.testnet), body, {
    ...(opts.fetchImpl === undefined ? {} : { fetchImpl: opts.fetchImpl }),
  });
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    // Summarise rather than dumping the raw zod issue array, which is unusable
    // for an agent consuming this output.
    const paths = parsed.error.issues.slice(0, 5).map((i) => i.path.join("."));
    throw new ApiError(
      `response for info type "${String((body as { type: string }).type)}" did not match the expected schema`,
      { issues: paths, issueCount: parsed.error.issues.length },
    );
  }
  return parsed.data;
}

export const getMeta = (o: InfoOptions) => info({ type: "meta" }, metaSchema, o);
export const getSpotMeta = (o: InfoOptions) => info({ type: "spotMeta" }, spotMetaSchema, o);
export const getMetaAndCtx = (o: InfoOptions) =>
  info({ type: "metaAndAssetCtxs" }, metaAndCtxSchema, o);
export const getSpotMetaAndCtx = (o: InfoOptions) =>
  info({ type: "spotMetaAndAssetCtxs" }, spotMetaAndCtxSchema, o);
export const getAllMids = (o: InfoOptions) =>
  info({ type: "allMids" }, z.record(z.string(), dec), o);
export const getExchangeStatus = (o: InfoOptions) =>
  info({ type: "exchangeStatus" }, exchangeStatusSchema, o);
export const getPredictedFundings = (o: InfoOptions) =>
  info({ type: "predictedFundings" }, predictedFundingSchema, o);

export const getCandles = (
  req: { coin: string; interval: string; startTime: number; endTime: number },
  o: InfoOptions,
) => info({ type: "candleSnapshot", req }, z.array(candleSchema), o);

export const getRecentTrades = (coin: string, o: InfoOptions) =>
  info({ type: "recentTrades", coin }, z.array(tradeSchema), o);

export const getL2Book = (coin: string, o: InfoOptions) =>
  info({ type: "l2Book", coin }, l2BookSchema, o);

export function getClearinghouseState(user: string, o: InfoOptions) {
  return info({ type: "clearinghouseState", user }, z.unknown(), o);
}
export function getSpotClearinghouseState(user: string, o: InfoOptions) {
  return info({ type: "spotClearinghouseState", user }, z.unknown(), o);
}
export function getOpenOrders(user: string, o: InfoOptions) {
  return info({ type: "openOrders", user }, z.array(z.unknown()), o);
}
export function getOrderStatus(user: string, oid: number | string, o: InfoOptions) {
  return info({ type: "orderStatus", user, oid }, z.unknown(), o);
}
export function getUserFills(user: string, o: InfoOptions) {
  return info({ type: "userFills", user }, z.array(z.unknown()), o);
}
export function getUserFunding(user: string, startTime: number, o: InfoOptions) {
  return info({ type: "userFunding", user, startTime }, z.array(z.unknown()), o);
}
export function getLedger(user: string, startTime: number, o: InfoOptions) {
  return info({ type: "userNonFundingLedgerUpdates", user, startTime }, z.array(z.unknown()), o);
}
export function getRateLimit(user: string, o: InfoOptions) {
  return info({ type: "userRateLimit", user }, z.unknown(), o);
}
export function getUserRole(user: string, o: InfoOptions) {
  return info({ type: "userRole", user }, z.unknown(), o);
}
