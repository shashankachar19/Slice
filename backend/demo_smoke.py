import json
from pathlib import Path

from fastapi.testclient import TestClient

import main


def run_demo() -> None:
    client = TestClient(main.app)
    image_candidates = list((Path(__file__).resolve().parent / "test_receipts" / "images").glob("r032.*"))
    if not image_candidates:
        raise RuntimeError("Demo image r032.* not found in backend/test_receipts/images")
    image_path = image_candidates[0]

    with open(image_path, "rb") as f:
        scan_resp = client.post(
            "/scan-bill?include_debug=false&use_hybrid=true",
            files={"file": (image_path.name, f.read(), "image/jpeg")},
        )
    scan_resp.raise_for_status()
    scan_data = scan_resp.json()
    items = scan_data.get("items", [])[:6]
    if not items:
        raise RuntimeError("No items extracted in demo scan")

    create_payload = {"lobby_name": "Smoke Demo", "lobby_passcode": "1234", "items": items}
    create_resp = client.post("/lobby/create", json=create_payload)
    create_resp.raise_for_status()
    lobby = create_resp.json()
    lobby_id = lobby["lobby_id"]

    join_a = client.post(f"/lobby/{lobby_id}/join", json={"user_name": "Alice", "lobby_passcode": "1234"})
    join_b = client.post(f"/lobby/{lobby_id}/join", json={"user_name": "Bob", "lobby_passcode": "1234"})
    join_a.raise_for_status()
    join_b.raise_for_status()
    alice_id = join_a.json()["user_id"]
    bob_id = join_b.json()["user_id"]

    if len(items) >= 2:
        client.post(
            f"/lobby/{lobby_id}/claim",
            json={"user_id": alice_id, "item_id": items[0]["id"], "quantity": 1, "lobby_passcode": "1234"},
        ).raise_for_status()
        client.post(
            f"/lobby/{lobby_id}/claim",
            json={"user_id": bob_id, "item_id": items[1]["id"], "quantity": 1, "lobby_passcode": "1234"},
        ).raise_for_status()

    summary_resp = client.get(
        f"/lobby/{lobby_id}/summary?format=compact",
        headers={"X-Lobby-Passcode": "1234"},
    )
    summary_resp.raise_for_status()
    summary = summary_resp.json()

    print("=== Smoke Demo OK ===")
    print("Scan source:", scan_data.get("source"))
    print("Items extracted:", len(scan_data.get("items", [])))
    print("Lobby ID:", lobby_id)
    print("Compact summary:")
    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    run_demo()
