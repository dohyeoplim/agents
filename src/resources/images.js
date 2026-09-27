const maxBytes = 5 * 1024 * 1024;

export function imageType(data) {
    if (data.length > maxBytes) throw Error("Image exceeds the 5 MB limit");
    if (data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png";
    if (data[0] === 255 && data[1] === 216 && data[2] === 255) return "image/jpeg";
    if (data.subarray(0, 4).toString() === "RIFF" && data.subarray(8, 12).toString() === "WEBP") return "image/webp";
    throw Error("Supported images: PNG, JPEG and WebP");
}

export function imageInput(data) {
    return `data:${imageType(data)};base64,${data.toString("base64")}`;
}

export function validateImages(images = []) {
    if (!Array.isArray(images) || images.length > 4) throw Error("Invalid images");
    for (const image of images) {
        if (typeof image !== "string" || image.length > 7000000) throw Error("Invalid image");
        const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(image);
        if (!match) throw Error("Invalid image");
        const data = Buffer.from(match[2], "base64");
        if (data.toString("base64") !== match[2] || imageType(data) !== match[1]) throw Error("Invalid image");
    }
    return images;
}
