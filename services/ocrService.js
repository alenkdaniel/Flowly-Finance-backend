import { createRequire } from "module";
import { createWorker } from "tesseract.js";
import KYC from "../models/KYC.js";

/**
 * OCR check for the uploaded PAN / Aadhaar image.
 *
 * It reads the ID number (and date of birth, if printed) from the picture and
 * compares it with what the customer typed in. The result is only a hint for
 * the officer - it never approves or rejects a KYC by itself.
 */

const require = createRequire(import.meta.url);

// English language data ships in an npm package, so OCR works offline
let langPath;
try {
  langPath = require("@tesseract.js-data/eng").langPath;
} catch {
  langPath = undefined; // falls back to downloading it on first use
}

// ---------------------------------------------------------------------------
// Pure helpers (easy to test)
// ---------------------------------------------------------------------------

// Verhoeff checksum - every real Aadhaar number passes it
const D = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], [1, 2, 3, 4, 0, 6, 7, 8, 9, 5],
  [2, 3, 4, 0, 1, 7, 8, 9, 5, 6], [3, 4, 0, 1, 2, 8, 9, 5, 6, 7],
  [4, 0, 1, 2, 3, 9, 5, 6, 7, 8], [5, 9, 8, 7, 6, 0, 4, 3, 2, 1],
  [6, 5, 9, 8, 7, 1, 0, 4, 3, 2], [7, 6, 5, 9, 8, 2, 1, 0, 4, 3],
  [8, 7, 6, 5, 9, 3, 2, 1, 0, 4], [9, 8, 7, 6, 5, 4, 3, 2, 1, 0],
];
const P = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], [1, 5, 7, 6, 2, 8, 3, 0, 9, 4],
  [5, 8, 0, 3, 7, 9, 6, 1, 4, 2], [8, 9, 1, 6, 0, 4, 3, 5, 2, 7],
  [9, 4, 5, 3, 1, 2, 6, 8, 7, 0], [4, 2, 8, 6, 5, 7, 3, 9, 0, 1],
  [2, 7, 9, 3, 8, 0, 6, 4, 1, 5], [7, 0, 4, 6, 9, 1, 3, 2, 5, 8],
];

export const verhoeffValid = (digits) => {
  if (!/^\d{12}$/.test(digits)) return false;
  let c = 0;
  digits
    .split("")
    .reverse()
    .forEach((ch, i) => {
      c = D[c][P[i % 8][Number(ch)]];
    });
  return c === 0;
};

export const maskAadhaar = (digits) => `XXXX XXXX ${digits.slice(-4)}`;

const normaliseId = (value, idType) => {
  const cleaned = String(value || "").replace(/[\s-]/g, "").toUpperCase();
  return idType === "aadhaar" ? cleaned.replace(/\D/g, "") : cleaned;
};

/** Pull ID numbers and a date of birth out of raw OCR text */
export const extractIdFields = (text) => {
  const raw = String(text || "");
  const upper = raw.toUpperCase();

  const panNumbers = [...new Set(upper.match(/\b[A-Z]{5}[0-9]{4}[A-Z]\b/g) || [])];

  const aadhaarNumbers = [];
  for (const m of raw.matchAll(/(?<!\d)(\d{4})\s?(\d{4})\s?(\d{4})(?!\d)/g)) {
    aadhaarNumbers.push(`${m[1]}${m[2]}${m[3]}`);
  }

  let dob;
  const dobMatch = raw.match(/\b(\d{2})[\/\-.](\d{2})[\/\-.](\d{4})\b/);
  if (dobMatch) dob = `${dobMatch[3]}-${dobMatch[2]}-${dobMatch[1]}`;

  return { panNumbers, aadhaarNumbers: [...new Set(aadhaarNumbers)], dob };
};

/** Compare what was read from the image with what the customer typed in */
export const compareWithSubmitted = ({ fields, idType, idNumber, dob, confidence }) => {
  const submitted = normaliseId(idNumber, idType);
  const candidates = idType === "pan" ? fields.panNumbers : fields.aadhaarNumbers;

  const result = {
    confidence: confidence != null ? Math.round(confidence) : undefined,
    extractedDob: fields.dob,
    dobMatched: fields.dob && dob ? fields.dob === dob : undefined,
  };

  if (!candidates.length) {
    return {
      ...result,
      status: "unreadable",
      reason: "Could not read an ID number from the image. Ask the customer for a clearer photo.",
    };
  }

  const matched = candidates.includes(submitted);
  const shown = matched ? submitted : candidates[0];

  return {
    ...result,
    status: matched ? "matched" : "mismatch",
    extractedIdNumber: idType === "aadhaar" ? maskAadhaar(shown) : shown,
    idNumberValid: idType === "aadhaar" ? verhoeffValid(shown) : undefined,
    reason: matched ? undefined : "The number on the image is different from the number entered.",
  };
};

// ---------------------------------------------------------------------------
// OCR engine
// ---------------------------------------------------------------------------

export const readTextFromImage = async (buffer) => {
  const worker = await createWorker("eng", 1, {
    ...(langPath ? { langPath, gzip: true } : {}),
    cacheMethod: "none",
  });
  try {
    const { data } = await worker.recognize(buffer);
    return { text: data.text, confidence: data.confidence };
  } finally {
    await worker.terminate();
  }
};

// One image at a time, so several uploads never overload the server
let queue = Promise.resolve();

/**
 * Run OCR in the background after a KYC submission. Never throws - the
 * outcome is saved on the KYC record (kyc.ocr).
 */
export const runKycOcrInBackground = ({ kycId, buffer, idType, idNumber, dob }) => {
  queue = queue.then(async () => {
    try {
      await KYC.findByIdAndUpdate(kycId, { "ocr.status": "processing" });

      const { text, confidence } = await readTextFromImage(buffer);
      const fields = extractIdFields(text);
      const result = compareWithSubmitted({ fields, idType, idNumber, dob, confidence });

      await KYC.findByIdAndUpdate(kycId, {
        ocr: { ...result, processedAt: new Date() },
      });
    } catch (err) {
      console.error(`OCR failed for KYC ${kycId}:`, err);
      await KYC.findByIdAndUpdate(kycId, {
        ocr: { status: "failed", reason: err.message, processedAt: new Date() },
      }).catch(() => {});
    }
  });
  return queue;
};

/** OCR only works on PAN / Aadhaar photos (not PDFs or other ID types) */
export const isOcrEligible = ({ idType, mimetype }) =>
  ["pan", "aadhaar"].includes(idType) && /^image\//.test(mimetype || "");