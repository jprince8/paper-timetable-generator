"""Browser access from the hosted timetable frontend."""

import os
import unittest
from unittest.mock import patch

with patch.dict(os.environ, {"RTT_TOKEN": "test-only"}):
    from app import app


class FrontendCorsTests(unittest.TestCase):
    def test_station_suggestions_are_readable_from_frontend(self):
        origin = "https://timetable.railwaytools.dev"
        response = app.test_client().get(
            "/api/stations?q=cambridge", headers={"Origin": origin}
        )
        self.assertEqual(response.status_code, 200)
        self.assertTrue(any(s["crsCode"] == "CBG" for s in response.json))
        self.assertEqual(response.headers.get("Access-Control-Allow-Origin"), origin)

    def test_frontend_can_access_each_backend_route_family(self):
        client = app.test_client()
        for origin in (
            "https://timetable.railwaytools.dev",
            "https://jprince8.github.io",
            "http://127.0.0.1:8080",
            "http://localhost:8080",
        ):
            for path, method in (
                ("/api/stations", "GET"),
                ("/rtt/search", "GET"),
                ("/timetable/pdf", "POST"),
                ("/timetable/xlsx", "POST"),
            ):
                with self.subTest(origin=origin, path=path):
                    response = client.options(path, headers={
                        "Origin": origin,
                        "Access-Control-Request-Method": method,
                        "Access-Control-Request-Headers": "content-type",
                    })
                    self.assertEqual(response.headers.get("Access-Control-Allow-Origin"), origin)
                    self.assertIn(method, response.headers.get("Access-Control-Allow-Methods", ""))

    def test_unlisted_origin_is_not_allowed(self):
        response = app.test_client().get(
            "/api/stations?q=cambridge", headers={"Origin": "https://example.com"}
        )
        self.assertNotIn("Access-Control-Allow-Origin", response.headers)


if __name__ == "__main__":
    unittest.main()
