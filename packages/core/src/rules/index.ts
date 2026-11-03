import { designGuard } from "./design-guard.js";
import { repeatedFailure } from "./repeated-failure.js";
import { repeatedRead } from "./repeated-read.js";
import { scopeFence } from "./scope-fence.js";
import { testTampering } from "./test-tampering.js";
import type { Rule } from "./types.js";

export type { Rule, RuleContext } from "./types.js";

export const builtinRules: Rule[] = [scopeFence, designGuard, testTampering, repeatedFailure, repeatedRead];
