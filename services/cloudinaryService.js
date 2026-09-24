import fs from "fs";
import cloudinary, { isCloudinaryConfigured } from "../config/cloudinary.js";

/**
 * Upload one in-memory file (multer memoryStorage buffer) to Cloudinary.
 *
 * KYC files are uploaded with type "authenticated", so the plain
 * res.cloudinary.com URL does NOT work for anyone. We store a *signed* URL
 * instead: it is not guessable, but it works anywhere it is used
 * (<img src>, officer review screen, etc.) with no extra code on the client.
 *
 * @param {Buffer} buffer
 * @param {{ userId: string, kind: "pan"|"aadhaar"|"selfie"|"document" }} meta
 * @returns {Promise<{ url: string, publicId: string, resourceType: string, format: string, bytes: number }>}
 */
export const uploadKycFile = (buffer, { userId, kind }) => {
  if (!isCloudinaryConfigured()) {
    return Promise.reject(
      new Error(
        "Cloudinary is not configured (set CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET)"
      )
    );
  }

  const root = process.env.CLOUDINARY_FOLDER || "flowly/kyc";

  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      {
        folder: `${root}/${userId}`,
        public_id: `${kind}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        resource_type: "auto", // images -> "image", PDFs -> "image" too
        type: "authenticated", // private delivery, signed URL required
        overwrite: false,
        tags: ["kyc", kind],
      },
      (error, result) => {
        if (error) return reject(error);

        const resourceType = result.resource_type || "image";
        const url = cloudinary.url(result.public_id, {
          resource_type: resourceType,
          type: "authenticated",
          sign_url: true,
          secure: true,
          version: result.version,
          format: resourceType === "raw" ? undefined : result.format,
        });

        resolve({
          url,
          publicId: result.public_id,
          resourceType,
          format: result.format,
          bytes: result.bytes,
        });
      }
    );

    stream.end(buffer);
  });
};

/**
 * Upload a generated FD certificate PDF (in-memory buffer) to Cloudinary.
 * Unlike KYC files, a certificate is meant to be openable by the customer
 * straight from an emailed/notified link, so it is uploaded as a normal
 * public "upload" resource rather than the "authenticated" type used for
 * private KYC documents.
 *
 * @param {Buffer} buffer
 * @param {{ userId: string, fdNumber: string }} meta
 * @returns {Promise<{ url: string, publicId: string, resourceType: string, format: string, bytes: number }>}
 */
export const uploadFDCertificate = (buffer, { userId, fdNumber }) => {
  if (!isCloudinaryConfigured()) {
    return Promise.reject(
      new Error(
        "Cloudinary is not configured (set CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET)"
      )
    );
  }

  const root = process.env.CLOUDINARY_FOLDER || "flowly";

  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      {
        folder: `${root}/fd-certificates/${userId}`,
        public_id: `${fdNumber}-certificate`,
        resource_type: "raw", // PDF
        type: "upload", // publicly fetchable, unlike KYC's "authenticated" files
        overwrite: true,
        format: "pdf",
        tags: ["fd", "certificate"],
      },
      (error, result) => {
        if (error) return reject(error);

        resolve({
          url: result.secure_url,
          publicId: result.public_id,
          resourceType: result.resource_type || "raw",
          format: result.format || "pdf",
          bytes: result.bytes,
        });
      }
    );

    stream.end(buffer);
  });
};

/** Best-effort delete (used to clean up if a later step of a submission fails). */
export const deleteKycFile = async ({ publicId, resourceType = "image" }) => {
  try {
    await cloudinary.uploader.destroy(publicId, {
      resource_type: resourceType,
      type: "authenticated",
      invalidate: true,
    });
  } catch (err) {
    console.error(`Cloudinary cleanup failed for ${publicId}:`, err.message);
  }
};

/**
 * Upload a video KYC recording (a file on disk) to Cloudinary as a private
 * video. The file is streamed, so it is never held in memory as a whole.
 *
 * @returns {Promise<{ url: string, publicId: string, resourceType: string, format: string, bytes: number, durationSeconds: number }>}
 */
export const uploadKycVideo = (filePath, { userId, sessionId }) => {
  if (!isCloudinaryConfigured()) {
    return Promise.reject(new Error("Cloudinary is not configured"));
  }

  const root = process.env.CLOUDINARY_FOLDER || "flowly/kyc";

  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      {
        folder: `${root}/${userId}/video-kyc`,
        public_id: `session-${sessionId}-${Date.now()}`,
        resource_type: "video",
        type: "authenticated",
        overwrite: false,
        tags: ["kyc", "video-kyc"],
      },
      (error, result) => {
        if (error) return reject(error);

        const url = cloudinary.url(result.public_id, {
          resource_type: "video",
          type: "authenticated",
          sign_url: true,
          secure: true,
          version: result.version,
          format: result.format,
        });

        resolve({
          url,
          publicId: result.public_id,
          resourceType: "video",
          format: result.format,
          bytes: result.bytes,
          durationSeconds: result.duration,
        });
      }
    );

    const source = fs.createReadStream(filePath);
    source.on("error", reject);
    source.pipe(stream);
  });
};