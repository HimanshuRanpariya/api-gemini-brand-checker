# api-gemini-brand-checker

# Gemini Brand Checker (API)

A small Express.js backend that queries a configured Google Gemini model (via Generative Language API)
to check whether a given brand is mentioned in generated or provided text. It exposes a simple
HTTP API for health checks and brand-check requests.

## Features

- Uses `axios` to call the Generative Language API when a `GEMINI_API_KEY` is configured.
- Parses model output into items and searches for brand mentions with fuzzy matching.
- Exposes a health endpoint and a `/api/check` endpoint for brand detection.

## Requirements

- Node.js 18+ (recommended)
- An optional Google Generative Language API key (`GEMINI_API_KEY`) if you want real model responses

## Installation

Clone the repo and install dependencies:

```powershell
git clone <repo-url>
cd api-gemini-brand-checker
npm install
```

## Environment

Create a `.env` file in the project root to configure runtime variables (optional):

```env
# Port to listen on (default 5000)
PORT=5000

# Google Generative Language API key (optional — if omitted, the server returns a canned fallback)
GEMINI_API_KEY=your_api_key_here

# (Optional) model name and temperature
GEMINI_MODEL=gemini-2.5-flash
GEMINI_TEMPERATURE=0.2
```

## Running

- Development (auto-restart with `nodemon`):

```powershell
npm run dev
```

- Production:

```powershell
npm start
```

- Build script (project-specific script):

```powershell
npm run build
```

## API

- Health check

	- Endpoint: `GET /ping`
	- Response: `200` with `{ "message": "pong" }`

- Brand check

	- Endpoint: `POST /api/check`
	- Body (JSON):

		```json
		{
			"prompt": "<text or prompt to send to the model>",
			"brand": "Acme"
		}
		```

	- Response (JSON):

		```json
		{
			"prompt": "...",
			"brand": "Acme",
			"mentioned": "Yes|No",
			"positions": [1, ...],
			"position": 1,
			"raw_text": "<raw text returned from model or canned fallback>",
			"used_model": "gemini-2.5-flash"
		}
		```

	- Notes:
		- If no `GEMINI_API_KEY` is configured the server returns a canned fallback text.
		- If the API call fails due to an invalid key or other provider error the server
			returns a helpful error payload with `providerStatus` and `providerDetail` where available.

## Implementation Notes

- Routes are defined in `routes/check.js` and `routes/ping.js`.
- The main logic lives in `controllers/checkController.js` which calls the Generative
	Language API and processes responses.
- Fuzzy matching and utilities are in `utils/brandUtils.js`.

## Troubleshooting

- Invalid API key errors: controller will return `401` with guidance to renew the key.
- Increase `GEMINI_TEMPERATURE` or `GEMINI_MODEL` in `.env` to experiment with model behavior.

## Contributing

PRs and issues welcome. Please open an issue describing the feature or bug first.

## License

This project does not include a license file. Add one if you intend to open-source it.
