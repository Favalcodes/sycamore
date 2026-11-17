/**
 * Seed data: two Nigerian businesses with ~6 months of realistic activity.
 *
 * Safe to re-run: organisations, users and accounts are upserted, and every
 * transaction has a deterministic external reference, so a second run inserts
 * nothing new (the unique constraint + skipDuplicates). Nothing is deleted.
 *
 * Transactions go in the way the API would put them in: confident rule
 * matches are classified immediately, everything else is left PENDING for the
 * background worker (and the AI provider) to pick up, and review detection
 * runs in the worker too.
 */
import 'dotenv/config';
import bcrypt from 'bcryptjs';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient, type Prisma } from '../src/generated/prisma/client.js';
import type { Direction } from '../src/generated/prisma/enums.js';
import { RulesClassifier } from '../src/classification/rules-classifier.js';
import { parseAmountToMinor } from '../src/common/money.js';
import { decideAtIngest } from '../src/classification/ingest-decisions.js';
import { descriptionKey } from '../src/classification/decision-memory.js';

const connectionString = process.env.DIRECT_URL ?? process.env.DATABASE_URL;
if (!connectionString)
  throw new Error('Set DIRECT_URL (or DATABASE_URL) before seeding');

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString }),
});
const rules = new RulesClassifier();
const RULES_ACCEPT = Number(process.env.RULES_ACCEPT_CONFIDENCE ?? 0.9);
const DEMO_PASSWORD = 'Password123!';
const DAYS = 180;

// Deterministic PRNG so every run generates identical data.
function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Random amount between two naira values, rounded to `step` naira, as integer kobo. */
function amountBetween(
  rand: () => number,
  minNaira: number,
  maxNaira: number,
  step = 1,
): bigint {
  const stepKobo = Math.round(step * 100);
  const kobo =
    Math.round(((minNaira + rand() * (maxNaira - minNaira)) * 100) / stepKobo) *
    stepKobo;
  return BigInt(kobo);
}

interface Tx {
  ref: string;
  account: string;
  amount: bigint;
  direction: Direction;
  description: string;
  merchant?: string;
  date: Date;
}

const today = new Date();
today.setUTCHours(0, 0, 0, 0);
/** A date `daysAgo` days back at a given Lagos hour (UTC+1). */
function day(daysAgo: number, hour = 10, minute = 0): Date {
  const d = new Date(today.getTime() - daysAgo * 86_400_000);
  d.setUTCHours(hour - 1, minute, 0, 0);
  return d;
}
function monthName(d: Date) {
  return d
    .toLocaleString('en-GB', {
      month: 'short',
      year: 'numeric',
      timeZone: 'Africa/Lagos',
    })
    .toUpperCase();
}
function isWeekday(d: Date) {
  const w = d.getUTCDay();
  return w !== 0 && w !== 6;
}

interface OrgSpec {
  slug: string;
  name: string;
  prefix: string;
  seed: number;
  users: Array<{ email: string; name: string }>;
  accounts: Array<{
    key: string;
    name: string;
    bankName: string;
    accountNumber: string;
  }>;
  build: (
    rand: () => number,
    add: (t: Omit<Tx, 'ref'> & { series: string }) => void,
  ) => void;
}

/** Bank charges that accompany an outgoing NIP transfer. */
function nipFees(
  add: (t: Omit<Tx, 'ref'> & { series: string }) => void,
  account: string,
  date: Date,
  amount: bigint,
) {
  const fee =
    amount <= 500_000n ? 1_075n : amount <= 5_000_000n ? 2_688n : 5_375n;
  add({
    series: 'FEE',
    account,
    amount: fee,
    direction: 'DEBIT',
    description: 'NIP TRANSFER FEE',
    date,
  });
  add({
    series: 'VAT',
    account,
    amount: (fee * 75n) / 1000n,
    direction: 'DEBIT',
    description: 'VAT ON NIP CHARGE',
    date,
  });
}

const ORGS: OrgSpec[] = [
  {
    slug: 'ofada-kitchen',
    name: 'Ofada Kitchen Supplies Ltd',
    prefix: 'OFD',
    seed: 1101,
    users: [
      { email: 'amaka@ofada.test', name: 'Amaka Okafor' },
      { email: 'tunde@ofada.test', name: 'Tunde Bakare' },
    ],
    accounts: [
      {
        key: 'ops',
        name: 'Operations Account',
        bankName: 'Guaranty Trust Bank',
        accountNumber: '0123456789',
      },
      {
        key: 'col',
        name: 'Collections Account',
        bankName: 'Moniepoint MFB',
        accountNumber: '6012345678',
      },
    ],
    build(rand, add) {
      for (let ago = DAYS; ago >= 1; ago--) {
        const d = day(ago);
        const dom = new Date(d.getTime() + 3_600_000).getUTCDate();

        // Revenue: card/online settlements into the collections account on weekdays.
        if (isWeekday(d)) {
          add({
            series: 'PSK',
            account: 'col',
            amount: amountBetween(rand, 280_000, 2_400_000, 0.25),
            direction: 'CREDIT',
            description: `PAYSTACK SETTLEMENT ${d.toISOString().slice(0, 10)}`,
            merchant: 'Paystack',
            date: day(ago, 9),
          });
          add({
            series: 'STD',
            account: 'col',
            amount: 5_000n,
            direction: 'DEBIT',
            description: 'STAMP DUTY CHARGE',
            date: day(ago, 9, 5),
          });
        }
        // Wholesale customers paying invoices by transfer.
        if (rand() < 0.22) {
          const customers = [
            'CHOPLIFE RESTAURANTS LTD',
            'MAMA PUT EATERY ENTERPRISES',
            'LAGOON BREEZE HOTELS',
            'BUKKA HUT FRANCHISE CO',
            'GREENFIELD SCHOOLS IKOYI',
          ];
          const c = customers[Math.floor(rand() * customers.length)];
          const inv = 20_000 + Math.floor(rand() * 900);
          add({
            series: 'INV',
            account: 'ops',
            amount: amountBetween(rand, 650_000, 6_800_000, 0.5),
            direction: 'CREDIT',
            description: `NIP TRF FROM ${c}/INV-${inv}`,
            date: day(ago, 13),
          });
        }
        // Weekly sweep from collections to operations.
        if (new Date(d.getTime()).getUTCDay() === 5) {
          const amt = amountBetween(rand, 3_000_000, 5_200_000, 1000);
          add({
            series: 'SWP',
            account: 'col',
            amount: amt,
            direction: 'DEBIT',
            description: 'SWEEP TO OPERATIONS ACCOUNT GTB',
            date: day(ago, 17),
          });
          add({
            series: 'SWI',
            account: 'ops',
            amount: amt,
            direction: 'CREDIT',
            description: 'INTER-ACCOUNT SWEEP FROM MONIEPOINT COLLECTIONS',
            date: day(ago, 17, 5),
          });
        }
        // Suppliers: ambiguous text that needs the AI.
        if (rand() < 0.12) {
          const suppliers = [
            'ADEBAYO FARMS LTD - CASSAVA FLOUR',
            'OKEKE PALM OIL MILLS',
            'NORTHERN GRAINS COOPERATIVE',
            'EKO PACKAGING SOLUTIONS',
            'IYA BASIRAT SPICES',
          ];
          const s = suppliers[Math.floor(rand() * suppliers.length)];
          const amt = amountBetween(rand, 420_000, 3_900_000, 50);
          add({
            series: 'SUP',
            account: 'ops',
            amount: amt,
            direction: 'DEBIT',
            description: `TRF TO ${s}`,
            date: day(ago, 11),
          });
          nipFees(add, 'ops', day(ago, 11, 1), amt);
        }
        if (rand() < 0.08) {
          const pos = [
            'POS PURCHASE - SHOPRITE LEKKI',
            'POS PURCHASE - HUBMART IKOYI',
            'WEB PURCHASE JUMIA NG',
            'POS PURCHASE - MRS OLA ENTERPRISES',
          ];
          add({
            series: 'POS',
            account: 'ops',
            amount: amountBetween(rand, 12_500, 186_000, 0.5),
            direction: 'DEBIT',
            description: pos[Math.floor(rand() * pos.length)],
            date: day(ago, 15),
          });
        }
        if (rand() < 0.1) {
          add({
            series: 'ELC',
            account: 'ops',
            amount: amountBetween(rand, 120_000, 260_000, 1000),
            direction: 'DEBIT',
            description: 'IKEJA ELECTRIC PREPAID TOKEN - WAREHOUSE',
            merchant: 'Ikeja Electric',
            date: day(ago, 8),
          });
        }
        if (rand() < 0.07) {
          add({
            series: 'BLT',
            account: 'ops',
            amount: amountBetween(rand, 4_500, 18_000, 50),
            direction: 'DEBIT',
            description: 'BOLT RIDE LAGOS',
            merchant: 'Bolt',
            date: day(ago, 18),
          });
        }

        // Monthly recurring items.
        if (dom === 25) {
          const amt = 8_450_000_00n;
          add({
            series: 'SAL',
            account: 'ops',
            amount: amt,
            direction: 'DEBIT',
            description: `SALARY PAYMENT ${monthName(d)} - STAFF PAYROLL`,
            date: day(ago, 9),
          });
          add({
            series: 'PEN',
            account: 'ops',
            amount: 676_000_00n,
            direction: 'DEBIT',
            description: 'PENSION REMITTANCE - STANBIC IBTC PFA',
            date: day(ago, 9, 30),
          });
        }
        if (dom === 10) {
          add({
            series: 'PAYE',
            account: 'ops',
            amount: amountBetween(rand, 1_080_000, 1_160_000, 0.01),
            direction: 'DEBIT',
            description: `LIRS PAYE REMITTANCE ${monthName(d)}`,
            date: day(ago, 12),
          });
        }
        if (dom === 21) {
          add({
            series: 'VATR',
            account: 'ops',
            amount: amountBetween(rand, 900_000, 1_700_000, 0.01),
            direction: 'DEBIT',
            description: `FIRS VAT REMITTANCE ${monthName(d)}`,
            date: day(ago, 12),
          });
        }
        if (dom === 1) {
          add({
            series: 'RNT',
            account: 'ops',
            amount: 1_850_000_00n,
            direction: 'DEBIT',
            description: 'WAREHOUSE LEASE PAYMENT - OREGUN IKEJA',
            date: day(ago, 10),
          });
          add({
            series: 'GWS',
            account: 'ops',
            amount: 86_400_00n,
            direction: 'DEBIT',
            description: 'GOOGLE *GSUITE OFADAKITCHEN',
            merchant: 'Google Workspace',
            date: day(ago, 6),
          });
          add({
            series: 'ZOH',
            account: 'ops',
            amount: 45_000_00n,
            direction: 'DEBIT',
            description: 'ZOHO BOOKS SUBSCRIPTION',
            merchant: 'Zoho',
            date: day(ago, 6, 30),
          });
          add({
            series: 'SMS',
            account: 'ops',
            amount: 1_200_00n,
            direction: 'DEBIT',
            description: 'SMS ALERT CHARGES',
            date: day(ago, 2),
          });
          add({
            series: 'SPN',
            account: 'ops',
            amount: 35_000_00n,
            direction: 'DEBIT',
            description: 'SPECTRANET INTERNET SUBSCRIPTION',
            merchant: 'Spectranet',
            date: day(ago, 7),
          });
        }
        if (dom === 5) {
          add({
            series: 'META',
            account: 'ops',
            amount: amountBetween(rand, 180_000, 320_000, 0.01),
            direction: 'DEBIT',
            description: 'META PLATFORMS ADS FACEBK *ADS',
            merchant: 'Meta',
            date: day(ago, 14),
          });
        }
        if (dom === 15 && rand() < 0.7) {
          add({
            series: 'DSL',
            account: 'ops',
            amount: amountBetween(rand, 380_000, 560_000, 500),
            direction: 'DEBIT',
            description: 'DIESEL SUPPLY FOR GENERATOR - TOTALENERGIES',
            date: day(ago, 9),
          });
        }
      }

      // --- Transactions that should trigger review --------------------------
      // Same supplier invoice paid twice through different channels.
      add({
        series: 'DUP',
        account: 'ops',
        amount: 4_750_000_00n,
        direction: 'DEBIT',
        description: 'TRF TO ADEBAYO FARMS LTD INV-88412 CASSAVA FLOUR',
        date: day(12, 11),
      });
      add({
        series: 'DUP',
        account: 'ops',
        amount: 4_750_000_00n,
        direction: 'DEBIT',
        description: 'TRF TO ADEBAYO FARMS LTD/INV-88412/CASSAVA FLOUR',
        date: day(11, 16),
      });
      // Capital purchase far above anything normal.
      add({
        series: 'BIG',
        account: 'ops',
        amount: 38_500_000_00n,
        direction: 'DEBIT',
        description: 'TRF TO FROSTLINE ENGINEERING - COLD ROOM EQUIPMENT',
        date: day(6, 10),
      });
      // Unusual payout from the collections account (normally only sweeps and fees).
      add({
        series: 'ODD',
        account: 'col',
        amount: 14_800_000_00n,
        direction: 'DEBIT',
        description: 'TRF TO K. OKONKWO',
        date: day(4, 21),
      });
      // A refund that reads like an expense.
      add({
        series: 'RFD',
        account: 'ops',
        amount: 212_750_00n,
        direction: 'CREDIT',
        description: 'AWS EMEA REFUND - DUPLICATE CHARGE',
        date: day(8, 9),
      });
      // Ambiguous inbound transfer.
      add({
        series: 'AMB',
        account: 'ops',
        amount: 450_000_00n,
        direction: 'CREDIT',
        description: 'TRF FROM CHIDI NWOSU',
        date: day(3, 19),
      });
    },
  },
  {
    slug: 'kanem-logistics',
    name: 'Kanem Logistics Nigeria Ltd',
    prefix: 'KNM',
    seed: 2202,
    users: [
      { email: 'hauwa@kanem.test', name: 'Hauwa Bello' },
      { email: 'emeka@kanem.test', name: 'Emeka Eze' },
    ],
    accounts: [
      {
        key: 'main',
        name: 'Main Current Account',
        bankName: 'Zenith Bank',
        accountNumber: '1012345678',
      },
      {
        key: 'pay',
        name: 'Payroll Account',
        bankName: 'Access Bank',
        accountNumber: '0698765432',
      },
    ],
    build(rand, add) {
      for (let ago = DAYS; ago >= 1; ago--) {
        const d = day(ago);
        const dom = new Date(d.getTime() + 3_600_000).getUTCDate();

        if (isWeekday(d) && rand() < 0.55) {
          const clients = [
            'NESTLE NIGERIA DISTRIBUTION',
            'JUMIA LOGISTICS PARTNER',
            'DANLAMI AGRO EXPORTS',
            'BLUECHIP PHARMA LTD',
            'SAHEL CEMENT TRADERS',
          ];
          const c = clients[Math.floor(rand() * clients.length)];
          add({
            series: 'INV',
            account: 'main',
            amount: amountBetween(rand, 1_200_000, 9_400_000, 0.5),
            direction: 'CREDIT',
            description: `NIP TRF FROM ${c} - PAYMENT FOR SERVICES INV-${4000 + Math.floor(rand() * 999)}`,
            date: day(ago, 12),
          });
        }
        if (isWeekday(d) && rand() < 0.6) {
          const amt = amountBetween(rand, 650_000, 2_900_000, 500);
          add({
            series: 'FUEL',
            account: 'main',
            amount: amt,
            direction: 'DEBIT',
            description: 'TRF TO MRS BELLO FUEL DEPOT - AGO FOR FLEET',
            date: day(ago, 7),
          });
          nipFees(add, 'main', day(ago, 7, 1), amt);
        }
        if (rand() < 0.15) {
          const parts = [
            'TRF TO LADIPO AUTO SPARES - TRUCK PARTS',
            'TRF TO ALHAJI MUSA TYRES',
            'TRF TO KANO TOLL & HAULAGE AGENT',
            'TRF TO ROAD SAFETY PERMIT AGENT',
          ];
          const amt = amountBetween(rand, 85_000, 1_400_000, 50);
          add({
            series: 'OPS',
            account: 'main',
            amount: amt,
            direction: 'DEBIT',
            description: parts[Math.floor(rand() * parts.length)],
            date: day(ago, 14),
          });
          nipFees(add, 'main', day(ago, 14, 1), amt);
        }
        if (rand() < 0.06) {
          add({
            series: 'AIR',
            account: 'main',
            amount: amountBetween(rand, 98_000, 245_000, 50),
            direction: 'DEBIT',
            description: 'AIR PEACE ABV-LOS TICKET',
            merchant: 'Air Peace',
            date: day(ago, 8),
          });
        }
        if (rand() < 0.04) {
          add({
            series: 'HTL',
            account: 'main',
            amount: amountBetween(rand, 160_000, 420_000, 50),
            direction: 'DEBIT',
            description: 'TRANSCORP HILTON ABUJA HOTEL',
            date: day(ago, 20),
          });
        }

        if (dom === 24) {
          add({
            series: 'FND',
            account: 'main',
            amount: 21_500_000_00n,
            direction: 'DEBIT',
            description: 'FUNDING OF PAYROLL ACCOUNT - ACCESS',
            date: day(ago, 15),
          });
          add({
            series: 'FNI',
            account: 'pay',
            amount: 21_500_000_00n,
            direction: 'CREDIT',
            description: 'INTER-ACCOUNT TRANSFER FROM ZENITH MAIN',
            date: day(ago, 15, 10),
          });
        }
        if (dom === 25) {
          add({
            series: 'SAL',
            account: 'pay',
            amount: 14_200_000_00n,
            direction: 'DEBIT',
            description: `SALARIES ${monthName(d)} - DRIVERS AND STAFF`,
            date: day(ago, 9),
          });
          add({
            series: 'BON',
            account: 'pay',
            amount: amountBetween(rand, 1_100_000, 1_900_000, 500),
            direction: 'DEBIT',
            description: `DRIVER TRIP ALLOWANCES ${monthName(d)}`,
            date: day(ago, 9, 30),
          });
          add({
            series: 'PEN',
            account: 'pay',
            amount: 1_136_000_00n,
            direction: 'DEBIT',
            description: 'PENSION REMITTANCE - ARM PFA',
            date: day(ago, 10),
          });
        }
        if (dom === 10) {
          add({
            series: 'PAYE',
            account: 'pay',
            amount: amountBetween(rand, 1_800_000, 1_950_000, 0.01),
            direction: 'DEBIT',
            description: `FCT-IRS PAYE REMITTANCE ${monthName(d)}`,
            date: day(ago, 12),
          });
          add({
            series: 'WHT',
            account: 'main',
            amount: amountBetween(rand, 300_000, 650_000, 0.01),
            direction: 'DEBIT',
            description: 'FIRS WITHHOLDING TAX REMITTANCE',
            date: day(ago, 12, 30),
          });
        }
        if (dom === 1) {
          add({
            series: 'RNT',
            account: 'main',
            amount: 3_200_000_00n,
            direction: 'DEBIT',
            description: 'TRUCK PARK RENT - KUJE ABUJA',
            date: day(ago, 10),
          });
          add({
            series: 'AWS',
            account: 'main',
            amount: amountBetween(rand, 240_000, 390_000, 0.01),
            direction: 'DEBIT',
            description: 'AWS EMEA AWS.AMAZON.CO',
            merchant: 'Amazon Web Services',
            date: day(ago, 4),
          });
          add({
            series: 'MSF',
            account: 'main',
            amount: 118_500_00n,
            direction: 'DEBIT',
            description: 'MICROSOFT 365 BUSINESS',
            merchant: 'Microsoft',
            date: day(ago, 4, 30),
          });
          add({
            series: 'TRK',
            account: 'main',
            amount: 275_000_00n,
            direction: 'DEBIT',
            description: 'FLEETTRACK NG - GPS TRACKING SUBSCRIPTION',
            date: day(ago, 5),
          });
          add({
            series: 'MNT',
            account: 'main',
            amount: 1_000_00n,
            direction: 'DEBIT',
            description: 'ACCOUNT MAINTENANCE FEE',
            date: day(ago, 2),
          });
          add({
            series: 'SMS',
            account: 'main',
            amount: 1_850_00n,
            direction: 'DEBIT',
            description: 'SMS ALERT CHARGES',
            date: day(ago, 2, 5),
          });
          add({
            series: 'MTN',
            account: 'main',
            amount: 60_000_00n,
            direction: 'DEBIT',
            description: 'MTN CORPORATE DATA BUNDLE',
            merchant: 'MTN',
            date: day(ago, 8),
          });
          add({
            series: 'AED',
            account: 'main',
            amount: amountBetween(rand, 180_000, 300_000, 1000),
            direction: 'DEBIT',
            description: 'AEDC POSTPAID BILL - DEPOT',
            merchant: 'Abuja Electricity',
            date: day(ago, 9),
          });
        }
        if (dom === 18 && rand() < 0.6) {
          add({
            series: 'MKT',
            account: 'main',
            amount: amountBetween(rand, 400_000, 1_500_000, 1000),
            direction: 'DEBIT',
            description: 'TRUCK BRANDING AND VEHICLE WRAPS - PRINTMASTERS',
            date: day(ago, 11),
          });
        }
      }

      // --- Transactions that should trigger review --------------------------
      add({
        series: 'BIG',
        account: 'main',
        amount: 96_000_000_00n,
        direction: 'DEBIT',
        description: 'TRF TO HALLMARK MOTORS - 2 UNITS MAN DIESEL TRUCKS',
        date: day(9, 10),
      });
      add({
        series: 'DUP',
        account: 'main',
        amount: 2_340_000_00n,
        direction: 'DEBIT',
        description: 'TRF TO LADIPO AUTO SPARES - TRUCK PARTS INV 7731',
        date: day(5, 10),
      });
      add({
        series: 'DUP',
        account: 'main',
        amount: 2_340_000_00n,
        direction: 'DEBIT',
        description: 'TRF TO LADIPO AUTO SPARES - TRUCK PARTS INV-7731',
        date: day(5, 15),
      });
      add({
        series: 'ODD',
        account: 'pay',
        amount: 1_250_000_00n,
        direction: 'CREDIT',
        description: 'REVERSAL - SALARY PAYMENT RETURNED ACCT CLOSED',
        date: day(20, 11),
      });
      add({
        series: 'AMB',
        account: 'main',
        amount: 780_000_00n,
        direction: 'DEBIT',
        description: 'TRF TO SANI IBRAHIM',
        date: day(2, 18),
      });
    },
  },
];

async function seedOrg(spec: OrgSpec, passwordHash: string) {
  const org = await prisma.organisation.upsert({
    where: { slug: spec.slug },
    update: {},
    create: { slug: spec.slug, name: spec.name },
  });
  for (const u of spec.users) {
    await prisma.user.upsert({
      where: { email: u.email },
      update: {},
      create: {
        organisationId: org.id,
        email: u.email,
        name: u.name,
        passwordHash,
      },
    });
  }
  const accountIds = new Map<string, string>();
  for (const a of spec.accounts) {
    const account = await prisma.account.upsert({
      where: {
        organisationId_bankName_accountNumber: {
          organisationId: org.id,
          bankName: a.bankName,
          accountNumber: a.accountNumber,
        },
      },
      update: {},
      create: {
        organisationId: org.id,
        name: a.name,
        bankName: a.bankName,
        accountNumber: a.accountNumber,
      },
    });
    accountIds.set(a.key, account.id);
  }

  const rand = mulberry32(spec.seed);
  const txs: Tx[] = [];
  const counters = new Map<string, number>();
  spec.build(rand, ({ series, ...t }) => {
    const n = (counters.get(series) ?? 0) + 1;
    counters.set(series, n);
    txs.push({
      ...t,
      ref: `${spec.prefix}-${series}-${String(n).padStart(5, '0')}`,
    });
  });

  const decisions = await decideAtIngest(
    prisma,
    org.id,
    txs.map((t) => ({
      ref: t.ref,
      description: t.description,
      merchant: t.merchant ?? null,
      direction: t.direction,
      amountMinor: t.amount,
      currency: 'NGN',
    })),
    rules,
    RULES_ACCEPT,
  );
  const rows: Prisma.TransactionCreateManyInput[] = txs.map((t) => {
    const d = decisions.get(t.ref);
    return {
      organisationId: org.id,
      accountId: accountIds.get(t.account)!,
      externalReference: t.ref,
      amountMinor: t.amount,
      currency: 'NGN',
      direction: t.direction,
      description: t.description,
      descriptionKey: descriptionKey(t.description),
      merchant: t.merchant ?? null,
      transactionDate: t.date,
      createdAt: new Date(t.date.getTime() + 2 * 3_600_000),
      ...(d
        ? {
            category: d.category,
            categorySource: d.source,
            categoryConfidence: d.confidence,
            classificationStatus: 'CLASSIFIED' as const,
          }
        : {}),
    };
  });

  let created = 0;
  for (let i = 0; i < rows.length; i += 500) {
    const chunk = rows.slice(i, i + 500);
    const inserted = await prisma.transaction.createManyAndReturn({
      data: chunk,
      skipDuplicates: true,
      select: { id: true, externalReference: true },
    });
    created += inserted.length;
    const events: Prisma.ClassificationEventCreateManyInput[] =
      inserted.flatMap((row) => {
        const d = decisions.get(row.externalReference);
        return d
          ? [
              {
                organisationId: org.id,
                transactionId: row.id,
                category: d.category,
                source: d.source,
                provider: d.provider,
                confidence: d.confidence,
                rationale: d.rationale,
              },
            ]
          : [];
      });
    if (events.length)
      await prisma.classificationEvent.createMany({ data: events });
  }

  const pending = rows.length - decisions.size;
  console.log(
    `  ${spec.name}: ${txs.length} transactions generated, ${created} newly inserted ` +
      `(${decisions.size} decided by rules or history, ${pending} queued for AI)`,
  );
}

async function main() {
  // Sanity check that the money helpers agree with the stored representation.
  if (parseAmountToMinor('12999.75') !== 1_299_975n)
    throw new Error('money parsing is broken');

  console.log('Seeding (non-destructive; safe to re-run)...');
  const passwordHash = await bcrypt.hash(DEMO_PASSWORD, 12);
  for (const spec of ORGS) await seedOrg(spec, passwordHash);
  console.log('\nDemo logins (password for all: Password123!)');
  for (const spec of ORGS)
    for (const u of spec.users)
      console.log(`  ${u.email.padEnd(22)} ${spec.name}`);
  console.log(
    '\nStart the API (npm run start:dev): the worker runs review detection and AI classification in the background.',
  );
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
