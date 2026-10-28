import {it,expect} from "vitest";
import {assertSandbox,assertProofTransaction,ProofConfigSchema} from "../scripts/proof-config.js";
import {readFileSync} from "node:fs";
it("accepts labeled synthetic proof input",()=>{expect(ProofConfigSchema.parse(JSON.parse(readFileSync("proof-input.example.json","utf8"))).changed.monthlyPrice).toBe(90);});
it("refuses production, proxies and similar-looking hosts",()=>{for(const host of ["https://api.airwallex.com","http://localhost:8788","https://api.sandbox.airwallex.com.evil.test"])expect(()=>assertSandbox(host)).toThrow();});
it("does not treat PENDING as a completed clearing",()=>{expect(()=>assertProofTransaction({status:"PENDING"},"CLEARING")).toThrow();});
it("requires the exact sandbox inactive-card decline",()=>{expect(()=>assertProofTransaction({status:"FAILED",failureReason:"LIMIT_EXCEEDED"},"CARD_INACTIVE")).toThrow();expect(()=>assertProofTransaction({status:"FAILED",failureReason:"CARD_INACTIVE"},"CARD_INACTIVE")).not.toThrow();});
