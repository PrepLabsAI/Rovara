import unittest

from deskbot.vertex_client import GeminiApiClient, ModelError, VertexClient, answer_text
from fake_vertex.server import start_in_thread


class ClientTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = start_in_thread()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()

    def test_vertex_path_names_project_location_and_model(self):
        client = VertexClient("sample-project-1", "europe-west1", "gemini-2.5-flash", token_provider=lambda: "t")
        self.assertEqual(
            client.url(),
            "https://europe-west1-aiplatform.googleapis.com/v1/projects/sample-project-1/locations/europe-west1/publishers/google/models/gemini-2.5-flash:generateContent",
        )

    def test_gemini_api_path_has_no_project(self):
        self.assertEqual(GeminiApiClient("http://h/p/gemini/x/tok/", "m", "k").url(), "http://h/p/gemini/x/tok/v1beta/models/m:generateContent")

    def test_both_shapes_get_an_answer(self):
        contents = [{"role": "user", "parts": [{"text": "Policy notes:\n- Standard shipping takes 5 business days.\n\nCustomer question: How long does shipping take?"}]}]
        vertex = VertexClient("sample-project-1", "us-central1", "m", self.server.endpoint, token_provider=lambda: "t")
        gemini = GeminiApiClient(self.server.endpoint, "m", "k")
        self.assertIn("5 business days", vertex.generate_content(contents, "Be brief."))
        self.assertIn("5 business days", gemini.generate_content(contents, "Be brief."))

    def test_http_errors_become_model_errors_without_the_request(self):
        client = GeminiApiClient(self.server.endpoint, "m", "")
        with self.assertRaises(ModelError) as raised:
            client.generate_content([{"role": "user", "parts": [{"text": "secret question"}]}])
        self.assertEqual(raised.exception.status, 401)
        self.assertNotIn("secret question", str(raised.exception))

    def test_an_answer_without_text_is_an_error(self):
        with self.assertRaises(ModelError):
            answer_text({"candidates": []})


if __name__ == "__main__":
    unittest.main()
