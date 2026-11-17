import type { Category, Direction } from '../generated/prisma/enums.js';
import type { ClassificationInput, ClassificationResult } from './provider.js';

interface Rule {
  id: string;
  category: Category;
  pattern: RegExp;
  confidence: number;
  /** Only applies to this direction of money movement. */
  direction?: Direction;
}

/**
 * Deterministic keyword rules for Nigerian business banking text.
 *
 * Ordered: the first matching rule wins, so specific rules sit above general
 * ones (e.g. "VAT on NIP charge" is a bank fee, not a tax payment).
 * High-confidence matches are accepted without calling the model, which is
 * the main lever on AI cost: most bank fees, payroll runs, tax remittances
 * and SaaS bills are unambiguous.
 */
export const RULES_VERSION = 'rules:v1';

const RULES: Rule[] = [
  {
    id: 'bank-fees',
    category: 'BANK_FEES',
    pattern:
      /\b(sms (alert|charge|notification)s?|stamp duty|emtl|electronic money transfer levy|vat on (nip|transfer|commission|charges?)|nip (fee|charge|commission)|transfer (fee|charge|commission)|(account|card) maintenance|cot\b|commission on turnover|bank charges?|token fee|cheque book)/i,
    confidence: 0.96,
  },
  {
    id: 'own-transfer',
    category: 'TRANSFERS',
    pattern:
      /\b(own account|self transfer|sweep|inter-?account|transfer to (savings|treasury)|funding of|fund transfer between)/i,
    confidence: 0.9,
  },
  {
    id: 'tax',
    category: 'TAX',
    pattern:
      /\b(firs|lirs|irs\b|internal revenue|paye( remittance| tax)?|withholding tax|\bwht\b|vat remittance|value added tax|company income tax|\bcit\b|education tax|tax (payment|remittance)|remita.*tax)/i,
    confidence: 0.94,
    direction: 'DEBIT',
  },
  {
    id: 'payroll',
    category: 'PAYROLL',
    pattern:
      /\b(salary|salaries|payroll|staff pay|wages|bonus|pension|\bpfa\b|\bnhf\b|13th month)/i,
    confidence: 0.93,
    direction: 'DEBIT',
  },
  {
    id: 'software',
    category: 'SOFTWARE',
    pattern:
      /\b(aws|amazon web services|google (workspace|cloud|\*gsuite)|gsuite|microsoft (365|azure)|office 365|azure|slack|notion|github|atlassian|jira|zoom\.us|zoom video|figma|heroku|digitalocean|vercel|quickbooks|zoho|sage\b|canva|adobe|openai|hubspot|dropbox|cloudflare)/i,
    confidence: 0.93,
    direction: 'DEBIT',
  },
  {
    id: 'utilities',
    category: 'UTILITIES',
    pattern:
      /\b(ikeja electric|ikedc|ekedc|eko electric|aedc|abuja electric|phed|ibedc|kaduna electric|electricity|prepaid meter|diesel (supply|for (the )?generator)|generator (diesel|fuel)|lawma|water (board|corporation)|mtn|airtel|globacom|\bglo\b|9mobile|spectranet|starlink|ipnx|smile comm|internet subscription|data subscription)/i,
    confidence: 0.92,
    direction: 'DEBIT',
  },
  {
    id: 'rent',
    category: 'RENT',
    pattern:
      /\b(rent|lease payment|office space|warehouse lease|service charge|facility management)\b/i,
    confidence: 0.9,
    direction: 'DEBIT',
  },
  {
    id: 'marketing',
    category: 'MARKETING',
    pattern:
      /\b(facebook ads|fb ads|meta (ads|platforms)|google ads|instagram ads|tiktok ads|linkedin ads|billboard|influencer|advert|marketing|branding|promo(tion)? campaign|radio jingle)/i,
    confidence: 0.92,
    direction: 'DEBIT',
  },
  {
    id: 'travel',
    category: 'TRAVEL',
    pattern:
      /\b(air peace|arik|ibom air|dana air|united nigeria airlines|overland airways|green africa|qatar airways|emirates|british airways|flight|airline|air ticket|hotel|uber|bolt\.eu|bolt ride|indrive|per diem|travel)/i,
    confidence: 0.9,
    direction: 'DEBIT',
  },
  {
    id: 'gateway-settlement',
    category: 'REVENUE',
    pattern:
      /\b(paystack|flutterwave|interswitch|monnify|opay|moniepoint).*(settlement|payout)|pos settlement|settlement.*(paystack|flutterwave)/i,
    confidence: 0.93,
    direction: 'CREDIT',
  },
  {
    id: 'customer-payment',
    category: 'REVENUE',
    pattern:
      /\b(inv[-\s]?\d+|invoice|payment for (order|supply|goods|services)|customer payment|sales proceeds)/i,
    confidence: 0.9,
    direction: 'CREDIT',
  },
  // Weak signal: a generic inbound transfer is usually, but not always, revenue.
  {
    id: 'generic-inbound-transfer',
    category: 'REVENUE',
    pattern:
      /\b(nip|trf|transfer|tfr)\b.*\bfrom\b|\bfrom\b.*\b(nip|trf|transfer)\b/i,
    confidence: 0.55,
    direction: 'CREDIT',
  },
];

export interface RuleMatch extends ClassificationResult {
  ruleId: string;
}

export class RulesClassifier {
  readonly name = RULES_VERSION;

  /** Best rule match, or null when nothing matches. */
  classify(input: ClassificationInput): RuleMatch | null {
    const text = `${input.description} ${input.merchant ?? ''}`;
    for (const rule of RULES) {
      if (rule.direction && rule.direction !== input.direction) continue;
      const match = rule.pattern.exec(text);
      if (match) {
        return {
          id: input.id,
          ruleId: rule.id,
          category: rule.category,
          confidence: rule.confidence,
          rationale: `Matched rule "${rule.id}" on "${match[0].trim()}"`,
        };
      }
    }
    return null;
  }
}
