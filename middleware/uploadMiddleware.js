import multer from "multer";

// Files are kept in memory only long enough to stream them to Cloudinary.
// Nothing is written to the server's disk any more.
const storage = multer.memoryStorage();

const allowedTypes = [
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/webp",
  "application/pdf",
];

const imageOnlyTypes = ["image/jpeg", "image/jpg", "image/png", "image/webp"];

function fileFilter(req, file, cb) {
  // The selfie must be a picture, never a PDF.
  const allowed = file.fieldname === "selfie" ? imageOnlyTypes : allowedTypes;

  if (allowed.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(
      new Error(
        file.fieldname === "selfie"
          ? "Selfie must be a JPG, PNG, or WEBP image"
          : "Only JPG, PNG, WEBP, or PDF files are allowed"
      )
    );
  }
}

const kycUpload = multer({
  storage,
  fileFilter,
  limits: { fileSize: 8 * 1024 * 1024, files: 4 }, // 8MB per file
}).fields([
  { name: "pan", maxCount: 1 },
  { name: "aadhaar", maxCount: 1 },
  { name: "selfie", maxCount: 1 },
  { name: "document", maxCount: 1 }, // legacy single-file field
]);

// Wrapper so upload problems come back as a clean 400 instead of a 500.
export const uploadKycFiles = (req, res, next) => {
  kycUpload(req, res, (err) => {
    if (!err) return next();

    let message = err.message;
    if (err instanceof multer.MulterError) {
      message =
        err.code === "LIMIT_FILE_SIZE"
          ? "Each file must be 8 MB or smaller"
          : `Upload error: ${err.message}`;
    }
    return res.status(400).json({ success: false, message });
  });
};

// Single optional supporting document — used when a customer responds to a
// worker's "Request More Information" on a Fixed Deposit.
const fdInfoUpload = multer({
  storage,
  fileFilter,
  limits: { fileSize: 8 * 1024 * 1024, files: 1 },
}).single("document");

export const uploadFDSupportingDoc = (req, res, next) => {
  fdInfoUpload(req, res, (err) => {
    if (!err) return next();

    let message = err.message;
    if (err instanceof multer.MulterError) {
      message =
        err.code === "LIMIT_FILE_SIZE"
          ? "File must be 8 MB or smaller"
          : `Upload error: ${err.message}`;
    }
    return res.status(400).json({ success: false, message });
  });
};