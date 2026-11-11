import base64
import binascii
import json
import sys
from pathlib import Path

import cv2
import numpy as np
from ai_edge_litert.interpreter import Interpreter


MAX_FRAMES = 6
MAX_IMAGE_BYTES = 180_000
FACE_SIZE = 80


def fail(message):
    print(json.dumps({"ok": False, "error": message}))
    raise SystemExit(0)


def load_image(encoded):
    if not isinstance(encoded, str) or len(encoded) > MAX_IMAGE_BYTES * 4 // 3 + 256:
        fail("Invalid or oversized camera evidence.")

    prefix = "data:image/jpeg;base64,"
    if not encoded.startswith(prefix):
        fail("Camera evidence must be a JPEG data URL.")

    try:
        image_bytes = base64.b64decode(encoded[len(prefix):], validate=True)
    except (ValueError, binascii.Error):
        fail("Camera evidence was not valid base64.")

    if not image_bytes or len(image_bytes) > MAX_IMAGE_BYTES:
        fail("Camera evidence was empty or oversized.")

    image = cv2.imdecode(np.frombuffer(image_bytes, dtype=np.uint8), cv2.IMREAD_COLOR)
    if image is None or image.size == 0:
        fail("Camera evidence could not be decoded.")
    if max(image.shape[:2]) > 1920:
        fail("Camera evidence dimensions exceeded the limit.")
    return image


def pose_signal(face):
    right_eye = (float(face[4]), float(face[5]))
    left_eye = (float(face[6]), float(face[7]))
    nose = (float(face[8]), float(face[9]))
    right_distance = np.hypot(nose[0] - right_eye[0], nose[1] - right_eye[1])
    left_distance = np.hypot(nose[0] - left_eye[0], nose[1] - left_eye[1])
    total = right_distance + left_distance
    if not np.isfinite(total) or total <= 0:
        return None
    return float((right_distance - left_distance) / total)


def liveness_input(image, face):
    x, y, width, height = (float(value) for value in face[:4])
    side = max(width, height) * 2.7
    if not np.isfinite(side) or side < 20:
        fail("The detected face was too small.")

    center_x = x + width / 2
    center_y = y + height / 2
    left = int(round(center_x - side / 2))
    top = int(round(center_y - side / 2))
    edge = int(round(side))
    crop = np.full((edge, edge, 3), 114, dtype=np.uint8)

    source_left = max(0, left)
    source_top = max(0, top)
    source_right = min(image.shape[1], left + edge)
    source_bottom = min(image.shape[0], top + edge)
    if source_right <= source_left or source_bottom <= source_top:
        fail("The detected face was outside the camera image.")

    crop_left = source_left - left
    crop_top = source_top - top
    crop[
        crop_top:crop_top + source_bottom - source_top,
        crop_left:crop_left + source_right - source_left,
    ] = image[source_top:source_bottom, source_left:source_right]

    resized = cv2.resize(crop, (FACE_SIZE, FACE_SIZE), interpolation=cv2.INTER_LINEAR)
    return (resized.astype(np.float32) / 255.0).transpose(2, 0, 1)[None, ...]


def main():
    if len(sys.argv) != 4:
        fail("Liveness runtime was not configured.")

    payload = json.loads(sys.stdin.buffer.read())
    frames = payload.get("frames")
    engine = payload.get("engine")
    if not isinstance(frames, list) or not 1 <= len(frames) <= MAX_FRAMES:
        fail("The camera presentation was incomplete.")
    if engine not in ("legacy", "sface"):
        fail("The face engine was not recognized.")

    anti_spoof = Interpreter(model_path=sys.argv[1], num_threads=2)
    anti_spoof.allocate_tensors()
    anti_input = anti_spoof.get_input_details()[0]["index"]
    anti_output = anti_spoof.get_output_details()[0]["index"]

    detector = cv2.FaceDetectorYN.create(
        str(Path(sys.argv[2])), "", (640, 640), 0.6, 0.3, 5000
    )
    recognizer = None
    if engine == "sface":
        recognizer = cv2.FaceRecognizerSF.create(str(Path(sys.argv[3])), "")

    results = []
    for frame in frames:
        if not isinstance(frame, dict):
            fail("A camera frame was malformed.")

        image = load_image(frame.get("image"))
        height, width = image.shape[:2]
        detector.setInputSize((width, height))
        _, faces = detector.detect(image)
        if faces is None or len(faces) != 1:
            fail("A single face could not be verified in every camera frame.")

        face = faces[0].astype(np.float32)
        anti_spoof.set_tensor(anti_input, liveness_input(image, face))
        anti_spoof.invoke()
        scores = np.asarray(anti_spoof.get_tensor(anti_output)).reshape(-1)
        if scores.size != 3 or not np.isfinite(scores).all():
            fail("The liveness model returned an invalid result.")

        result = {
            "live": int(np.argmax(scores)) == 1,
            "pose_signal": pose_signal(face),
        }

        if recognizer is not None:
            aligned = recognizer.alignCrop(image, face)
            embedding = np.asarray(recognizer.feature(aligned), dtype=np.float32).reshape(-1)
            norm = float(np.linalg.norm(embedding))
            if embedding.size != 128 or not np.isfinite(norm) or norm <= 0:
                fail("The server face matcher returned an invalid result.")
            result["embedding"] = (embedding / norm).tolist()

        results.append(result)

    print(json.dumps({"ok": True, "frames": results}, separators=(",", ":")))


if __name__ == "__main__":
    try:
        main()
    except SystemExit:
        raise
    except Exception:
        fail("The local liveness runtime could not verify the camera presentation.")
