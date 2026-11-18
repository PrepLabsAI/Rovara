import json
import unittest

from deskbot.agent import DeskAgent, load_data, load_system_prompt, policy_notes
from deskbot.vertex_client import VertexClient
from fake_vertex.server import start_in_thread


class AgentTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = start_in_thread()
        cls.client = VertexClient("sample-project-1", "us-central1", "gemini-2.5-flash", cls.server.endpoint, token_provider=lambda: "placeholder-token")

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()

    def test_notes_name_matching_policies_and_orders(self):
        notes = policy_notes("How long does shipping take for order 1042?", load_data())
        self.assertIn("5 business days", notes)
        self.assertIn("Order 1042: status shipped", notes)

    def test_request_carries_system_prompt_and_notes(self):
        sent = {}

        class Spy:
            def generate_content(self, contents, system_instruction=None, generation_config=None):
                sent.update(contents=contents, system=system_instruction, config=generation_config)
                return "ok"

        DeskAgent(Spy()).answer("What is the return window?")
        self.assertEqual(sent["system"], load_system_prompt())
        self.assertIn("30 days", sent["contents"][0]["parts"][0]["text"])
        self.assertEqual(sent["config"], {"temperature": 0})

    def test_answers_a_policy_question_through_the_fake(self):
        self.assertIn("30 days", DeskAgent(self.client).answer("How many days do I have to return an item?"))

    def test_passes_unknown_questions_to_a_person(self):
        self.assertIn("person", DeskAgent(self.client).answer("Can you recommend a hiking trail?"))

    def test_system_prompt_file_is_not_empty(self):
        self.assertGreater(len(load_system_prompt()), 40)


if __name__ == "__main__":
    unittest.main()
