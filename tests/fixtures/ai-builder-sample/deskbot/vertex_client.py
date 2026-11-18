"""A small Vertex AI generateContent client (REST), shaped like the SDK calls a real agent makes.

Vertex AI path:  /v1/projects/<project>/locations/<location>/publishers/google/models/<model>:generateContent
Gemini API path: /v1beta/models/<model>:generateContent  (same body and answer shape)

`api_endpoint` lets a test or a sandbox point the client at another host, as the Vertex SDKs allow.
No third-party packages; nothing here talks to Google unless the endpoint and a token say so.
"""
from __future__ import annotations

import json
import os
import urllib.error
import urllib.request
from typing import Any, Callable, Optional


class ModelError(RuntimeError):
    """The model call failed. The message never holds the request or the credential."""

    def __init__(self, status: int, message: str = "model call failed") -> None:
        super().__init__(f"{message} (HTTP {status})")
        self.status = status


def _env_token() -> str:
    token = os.environ.get("GOOGLE_OAUTH_ACCESS_TOKEN", "")
    if not token:
        raise ModelError(0, "no Google credentials configured")
    return token


def _post(url: str, headers: dict, body: dict, timeout: float) -> dict:
    data = json.dumps(body).encode("utf-8")
    request = urllib.request.Request(url, data=data, method="POST", headers={"content-type": "application/json", **headers})
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:  # noqa: S310 (the endpoint is configuration)
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        raise ModelError(error.code) from None
    except (urllib.error.URLError, TimeoutError, OSError):
        raise ModelError(0, "model endpoint unreachable") from None


def _request_body(contents: list, system_instruction: Optional[str], generation_config: Optional[dict]) -> dict:
    body: dict = {"contents": contents}
    if system_instruction:
        body["systemInstruction"] = {"role": "system", "parts": [{"text": system_instruction}]}
    if generation_config:
        body["generationConfig"] = generation_config
    return body


def answer_text(response: dict) -> str:
    try:
        parts = response["candidates"][0]["content"]["parts"]
        return "".join(part.get("text", "") for part in parts).strip()
    except (KeyError, IndexError, TypeError):
        raise ModelError(200, "the model answer had no text") from None


class VertexClient:
    """Vertex AI: project and location in the path, a Google access token as a bearer."""

    def __init__(self, project: str, location: str, model: str, api_endpoint: Optional[str] = None,
                 token_provider: Callable[[], str] = _env_token, timeout: float = 30.0) -> None:
        self.project, self.location, self.model, self.timeout = project, location, model, timeout
        host = "aiplatform.googleapis.com" if location == "global" else f"{location}-aiplatform.googleapis.com"
        self.api_endpoint = (api_endpoint or f"https://{host}").rstrip("/")
        self.token_provider = token_provider

    def url(self) -> str:
        return (f"{self.api_endpoint}/v1/projects/{self.project}/locations/{self.location}"
                f"/publishers/google/models/{self.model}:generateContent")

    def generate_content(self, contents: list, system_instruction: Optional[str] = None, generation_config: Optional[dict] = None) -> str:
        headers = {"authorization": f"Bearer {self.token_provider()}"}
        return answer_text(_post(self.url(), headers, _request_body(contents, system_instruction, generation_config), self.timeout))


class GeminiApiClient:
    """The Gemini Developer API shape: the same model and the same body, an API key header, no project in the path."""

    def __init__(self, base_url: str, model: str, api_key: str, timeout: float = 30.0) -> None:
        self.base_url, self.model, self.api_key, self.timeout = base_url.rstrip("/"), model, api_key, timeout

    def url(self) -> str:
        return f"{self.base_url}/v1beta/models/{self.model}:generateContent"

    def generate_content(self, contents: list, system_instruction: Optional[str] = None, generation_config: Optional[dict] = None) -> str:
        headers = {"x-goog-api-key": self.api_key}
        return answer_text(_post(self.url(), headers, _request_body(contents, system_instruction, generation_config), self.timeout))
