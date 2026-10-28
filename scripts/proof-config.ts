import {z} from "zod";
export const ProofConfigSchema=z.object({
  caseId:z.literal("case_acme"),
  original:z.object({monthlyPrice:z.literal(100),annualPrice:z.literal(984),currency:z.literal("USD"),category:z.literal("software"),noticeDays:z.literal(30)}),
  changed:z.object({monthlyPrice:z.literal(90),annualPrice:z.literal(984),currency:z.literal("USD"),category:z.literal("software"),noticeDays:z.literal(30)}),
  originalText:z.string().min(1),changedText:z.string().min(1),
  inputLabel:z.literal("synthetic vendor document - file intake"),
});
export function assertSandbox(base:string){if(base!=="https://api.sandbox.airwallex.com")throw new Error("Only the Airwallex sandbox endpoint is permitted");}
export function assertProofTransaction(t:{status:string;failureReason?:string},expected:"CLEARING"|"CARD_INACTIVE"){
 if(expected==="CLEARING"&&t.status!=="CLEARING")throw new Error("Expected CLEARING; outcome must be reconciled");
 if(expected==="CARD_INACTIVE"&&(t.status!=="FAILED"||t.failureReason!=="CARD_INACTIVE"))throw new Error("Expected sandbox decline CARD_INACTIVE; outcome must be reconciled");
}
