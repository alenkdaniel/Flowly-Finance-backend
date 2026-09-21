import multer from "multer";
import os from "os";

const maxMb = Number(process.env.VIDEO_KYC_MAX_RECORDING_MB) || 100;

// Recordings can be large, so they go to a temp file instead of memory.
// The controller uploads the file to Cloudinary and then deletes it.
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, os.tmpdir()),
    filename: (req, file, cb) =>
      cb(null, `vkyc-${Date.now()}-${Math.round(Math.random() * 1e9)}.webm`),
  }),
  fileFilter: (req, file, cb) => {
    const isVideoType = file.mimetype && file.mimetype.startsWith("video/");

    // Browsers may send a type like "video/webm;codecs=vp8,opus". The comma
    // makes the type unreadable to the parser (it turns into "text/plain"),
    // so also accept a recording by its file extension in that case.
    const looksLikeVideoFile =
      /\.(webm|mp4|mkv|mov)$/i.test(file.originalname || "") &&
      ["text/plain", "application/octet-stream"].includes(file.mimetype);

    if (isVideoType || looksLikeVideoFile) return cb(null, true);
    cb(new Error("Recording must be a video file (webm or mp4)"));
  },
  limits: { fileSize: maxMb * 1024 * 1024, files: 1 },
}).single("recording");

export const uploadRecordingFile = (req, res, next) => {
  upload(req, res, (err) => {
    if (!err) return next();

    let message = err.message;
    if (err instanceof multer.MulterError && err.code === "LIMIT_FILE_SIZE") {
      message = `Recording must be ${maxMb} MB or smaller`;
    }
    return res.status(400).json({ success: false, message });
  });
};