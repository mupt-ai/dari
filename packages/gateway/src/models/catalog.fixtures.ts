// Entries captured from the public models endpoints on 2026-10-26, trimmed to
// the fields the catalog reads.

// https://openrouter.ai/api/v1/models
export const OPENROUTER_MODELS = {
  "data": [
    {
      "id": "openai/gpt-6.1-terra",
      "name": "OpenAI: GPT-6.1 Terra",
      "context_length": 1050000,
      "architecture": {
        "modality": "text+image+file->text",
        "input_modalities": [
          "file",
          "image",
          "text"
        ],
        "output_modalities": [
          "text"
        ],
        "tokenizer": "GPT",
        "instruct_type": null
      },
      "pricing": {
        "prompt": "0.000001",
        "completion": "0.000005",
        "web_search": "0.01",
        "input_cache_read": "0.00000005",
        "input_cache_write": "0.00000125",
        "overrides": [
          {
            "min_prompt_tokens": 272000,
            "prompt": "0.000002",
            "completion": "0.0000075",
            "input_cache_read": "0.0000001",
            "input_cache_write": "0.0000025"
          }
        ]
      },
      "top_provider": {
        "context_length": 1050000,
        "max_completion_tokens": 128000,
        "is_moderated": true
      },
      "supported_parameters": [
        "include_reasoning",
        "max_tokens",
        "reasoning",
        "reasoning_effort",
        "response_format",
        "seed",
        "structured_outputs",
        "tool_choice",
        "tools",
        "verbosity"
      ],
      "reasoning": {
        "mandatory": false,
        "default_enabled": true,
        "supported_efforts": [
          "max",
          "xhigh",
          "high",
          "medium",
          "low",
          "none"
        ],
        "default_effort": "medium"
      }
    },
    {
      "id": "anthropic/claude-sonnet-5.5",
      "name": "Anthropic: Claude Sonnet 5.5",
      "context_length": 1000000,
      "architecture": {
        "modality": "text+image+file->text",
        "input_modalities": [
          "text",
          "image",
          "file"
        ],
        "output_modalities": [
          "text"
        ],
        "tokenizer": "Claude",
        "instruct_type": null
      },
      "pricing": {
        "prompt": "0.000002",
        "completion": "0.00001",
        "web_search": "0.01",
        "input_cache_read": "0.0000001",
        "input_cache_write": "0.0000025",
        "input_cache_write_1h": "0.000004"
      },
      "top_provider": {
        "context_length": 1000000,
        "max_completion_tokens": 128000,
        "is_moderated": true
      },
      "supported_parameters": [
        "include_reasoning",
        "max_completion_tokens",
        "max_tokens",
        "reasoning",
        "reasoning_effort",
        "response_format",
        "stop",
        "structured_outputs",
        "tool_choice",
        "tools",
        "verbosity"
      ],
      "benchmarks": {
        "design_arena": [
          {
            "arena": "agents",
            "category": "blender3d",
            "elo": 1303,
            "win_rate": 64,
            "rank": 3
          },
          {
            "arena": "agents",
            "category": "mobileapps",
            "elo": 1281,
            "win_rate": 59.6,
            "rank": 3
          },
          {
            "arena": "agents",
            "category": "spreadsheet",
            "elo": 1287,
            "win_rate": 53.3,
            "rank": 4
          },
          {
            "arena": "agents",
            "category": "webapps",
            "elo": 1305,
            "win_rate": 60.3,
            "rank": 3
          },
          {
            "arena": "models",
            "category": "3d",
            "elo": 1400,
            "win_rate": 51.3,
            "rank": 5
          },
          {
            "arena": "models",
            "category": "codecategories",
            "elo": 1354,
            "win_rate": 56.3,
            "rank": 5
          },
          {
            "arena": "models",
            "category": "dataviz",
            "elo": 1387,
            "win_rate": 67.7,
            "rank": 2
          },
          {
            "arena": "models",
            "category": "gamedev",
            "elo": 1415,
            "win_rate": 62.2,
            "rank": 2
          },
          {
            "arena": "models",
            "category": "uicomponent",
            "elo": 1373,
            "win_rate": 63.2,
            "rank": 4
          },
          {
            "arena": "models",
            "category": "website",
            "elo": 1322,
            "win_rate": 54.5,
            "rank": 6
          }
        ],
        "artificial_analysis": {
          "intelligence_index": 56,
          "coding_index": null,
          "agentic_index": null
        }
      },
      "reasoning": {
        "mandatory": true,
        "supported_efforts": [
          "max",
          "xhigh",
          "high",
          "medium",
          "low"
        ],
        "default_effort": "high"
      }
    },
    {
      "id": "openrouter/auto",
      "name": "Auto Router",
      "context_length": 2000000,
      "architecture": {
        "modality": "text+image+file+audio+video->text+image",
        "input_modalities": [
          "text",
          "image",
          "audio",
          "file",
          "video"
        ],
        "output_modalities": [
          "text",
          "image"
        ],
        "tokenizer": "Router",
        "instruct_type": null
      },
      "pricing": {
        "prompt": "-1",
        "completion": "-1"
      },
      "top_provider": {
        "context_length": null,
        "max_completion_tokens": null,
        "is_moderated": false
      },
      "supported_parameters": [
        "frequency_penalty",
        "include_reasoning",
        "logit_bias",
        "logprobs",
        "max_tokens",
        "min_p",
        "prediction",
        "presence_penalty",
        "reasoning",
        "reasoning_effort",
        "repetition_penalty",
        "response_format",
        "seed",
        "stop",
        "structured_outputs",
        "temperature",
        "tool_choice",
        "tools",
        "top_a",
        "top_k",
        "top_logprobs",
        "top_p",
        "web_search_options"
      ]
    },
    {
      "id": "moondream/moondream3-preview",
      "name": "Moondream: Moondream 3 Preview",
      "context_length": 32000,
      "architecture": {
        "modality": "text+image->text",
        "input_modalities": [
          "text",
          "image"
        ],
        "output_modalities": [
          "text"
        ],
        "tokenizer": "Other",
        "instruct_type": null
      },
      "pricing": {
        "prompt": "0.0000003",
        "completion": "0.0000025"
      },
      "top_provider": {
        "context_length": 32000,
        "max_completion_tokens": 4096,
        "is_moderated": false
      },
      "supported_parameters": [
        "include_reasoning",
        "max_completion_tokens",
        "max_tokens",
        "reasoning",
        "temperature",
        "top_p"
      ],
      "reasoning": {
        "mandatory": false,
        "default_enabled": false
      }
    },
    {
      "id": "deepseek/deepseek-v4.1-flash-1017",
      "name": "DeepSeek: DeepSeek V4.1 Flash 1017",
      "context_length": 1048576,
      "architecture": {
        "modality": "text+image->text",
        "input_modalities": [
          "text",
          "image"
        ],
        "output_modalities": [
          "text"
        ],
        "tokenizer": "DeepSeek",
        "instruct_type": null
      },
      "pricing": {
        "prompt": "0.00000015",
        "completion": "0.0000006",
        "input_cache_read": "0.000000003",
        "overrides": [
          {
            "utc_days": [
              "saturday",
              "sunday"
            ],
            "prompt": "0.00000015",
            "completion": "0.0000006",
            "input_cache_read": "0.000000003"
          },
          {
            "utc_days": [
              "monday",
              "tuesday",
              "wednesday",
              "thursday",
              "friday"
            ],
            "utc_start": 0,
            "utc_end": 100,
            "prompt": "0.00000015",
            "completion": "0.0000006",
            "input_cache_read": "0.000000003"
          },
          {
            "utc_days": [
              "monday",
              "tuesday",
              "wednesday",
              "thursday",
              "friday"
            ],
            "utc_start": 100,
            "utc_end": 400,
            "prompt": "0.0000003",
            "completion": "0.0000012",
            "input_cache_read": "0.000000006"
          },
          {
            "utc_days": [
              "monday",
              "tuesday",
              "wednesday",
              "thursday",
              "friday"
            ],
            "utc_start": 400,
            "utc_end": 600,
            "prompt": "0.00000015",
            "completion": "0.0000006",
            "input_cache_read": "0.000000003"
          },
          {
            "utc_days": [
              "monday",
              "tuesday",
              "wednesday",
              "thursday",
              "friday"
            ],
            "utc_start": 600,
            "utc_end": 1000,
            "prompt": "0.0000003",
            "completion": "0.0000012",
            "input_cache_read": "0.000000006"
          },
          {
            "utc_days": [
              "monday",
              "tuesday",
              "wednesday",
              "thursday",
              "friday"
            ],
            "utc_start": 1000,
            "utc_end": 0,
            "prompt": "0.00000015",
            "completion": "0.0000006",
            "input_cache_read": "0.000000003"
          }
        ]
      },
      "top_provider": {
        "context_length": 1048576,
        "max_completion_tokens": 393216,
        "is_moderated": false
      },
      "supported_parameters": [
        "frequency_penalty",
        "include_reasoning",
        "logit_bias",
        "logprobs",
        "max_completion_tokens",
        "max_tokens",
        "min_p",
        "parallel_tool_calls",
        "presence_penalty",
        "reasoning",
        "reasoning_effort",
        "repetition_penalty",
        "response_format",
        "seed",
        "stop",
        "structured_outputs",
        "temperature",
        "tool_choice",
        "tools",
        "top_k",
        "top_logprobs",
        "top_p"
      ],
      "benchmarks": {
        "design_arena": [
          {
            "arena": "agents",
            "category": "spreadsheet",
            "elo": 1278,
            "win_rate": 51.2,
            "rank": 6
          },
          {
            "arena": "models",
            "category": "3d",
            "elo": 1360,
            "win_rate": 46.6,
            "rank": 10
          },
          {
            "arena": "models",
            "category": "asciiart",
            "elo": 1220,
            "win_rate": 50.8,
            "rank": 19
          },
          {
            "arena": "models",
            "category": "codecategories",
            "elo": 1290,
            "win_rate": 47.9,
            "rank": 20
          },
          {
            "arena": "models",
            "category": "dataviz",
            "elo": 1278,
            "win_rate": 51.6,
            "rank": 23
          },
          {
            "arena": "models",
            "category": "gamedev",
            "elo": 1266,
            "win_rate": 43.5,
            "rank": 28
          },
          {
            "arena": "models",
            "category": "svg",
            "elo": 1242,
            "win_rate": 51.4,
            "rank": 15
          },
          {
            "arena": "models",
            "category": "uicomponent",
            "elo": 1301,
            "win_rate": 53.5,
            "rank": 17
          },
          {
            "arena": "models",
            "category": "website",
            "elo": 1300,
            "win_rate": 52.9,
            "rank": 15
          }
        ],
        "artificial_analysis": {
          "intelligence_index": 39.5,
          "coding_index": null,
          "agentic_index": null
        }
      },
      "reasoning": {
        "mandatory": false,
        "default_enabled": true,
        "supported_efforts": [
          "max",
          "high",
          "low",
          "none"
        ],
        "default_effort": "high"
      }
    }
  ]
};

// https://ai-gateway.vercel.sh/v1/models
export const VERCEL_MODELS = {
  "object": "list",
  "data": [
    {
      "id": "alibaba/qwen3-max-thinking",
      "name": "Qwen 3 Max Thinking",
      "context_window": 256000,
      "max_tokens": 65536,
      "type": "language",
      "tags": [
        "reasoning",
        "tool-use",
        "structured-output"
      ],
      "modalities": {
        "input": [
          "text"
        ],
        "output": [
          "text"
        ]
      },
      "supported_parameters": [
        "max_tokens",
        "temperature",
        "stop",
        "tools",
        "tool_choice",
        "reasoning",
        "include_reasoning",
        "response_format",
        "structured_outputs"
      ],
      "reasoning_options": [
        {
          "type": "budget_tokens",
          "min": 1,
          "max": 81920
        }
      ],
      "pricing": {
        "input": "0.0000012",
        "input_tiers": [
          {
            "cost": "0.0000012",
            "min": 0,
            "max": 32001
          },
          {
            "cost": "0.0000024",
            "min": 32001,
            "max": 128001
          },
          {
            "cost": "0.000003",
            "min": 128001
          }
        ],
        "output": "0.000006",
        "output_tiers": [
          {
            "cost": "0.000006",
            "min": 0,
            "max": 32001
          },
          {
            "cost": "0.000012",
            "min": 32001,
            "max": 128001
          },
          {
            "cost": "0.000015",
            "min": 128001
          }
        ],
        "input_cache_read": "0.00000024",
        "input_cache_read_tiers": [
          {
            "cost": "0.00000024",
            "min": 0,
            "max": 32001
          },
          {
            "cost": "0.00000048",
            "min": 32001,
            "max": 128001
          },
          {
            "cost": "0.0000006",
            "min": 128001
          }
        ]
      }
    },
    {
      "id": "alibaba/qwen-3-14b",
      "name": "Qwen3-14B",
      "context_window": 40960,
      "max_tokens": 16384,
      "type": "language",
      "tags": [
        "reasoning",
        "tool-use",
        "structured-output",
        "open-weights"
      ],
      "modalities": {
        "input": [
          "text"
        ],
        "output": [
          "text"
        ]
      },
      "supported_parameters": [
        "max_tokens",
        "temperature",
        "stop",
        "tools",
        "tool_choice",
        "reasoning",
        "include_reasoning",
        "response_format",
        "structured_outputs"
      ],
      "reasoning_options": [
        {
          "type": "toggle"
        }
      ],
      "pricing": {
        "input": "0.00000012",
        "output": "0.00000024"
      }
    },
    {
      "id": "alibaba/qwen3-embedding-0.6b",
      "name": "Qwen3 Embedding 0.6B",
      "context_window": 32768,
      "max_tokens": 32768,
      "type": "embedding",
      "tags": [
        "open-weights"
      ],
      "modalities": {
        "input": [
          "text"
        ],
        "output": [
          "text"
        ]
      },
      "pricing": {
        "input": "0.00000001"
      }
    },
    {
      "id": "alibaba/qwen3.5-plus",
      "name": "Qwen 3.5 Plus",
      "context_window": 1000000,
      "max_tokens": 64000,
      "type": "language",
      "tags": [
        "vision",
        "file-input",
        "reasoning",
        "tool-use",
        "explicit-caching"
      ],
      "modalities": {
        "input": [
          "text",
          "image",
          "pdf"
        ],
        "output": [
          "text"
        ]
      },
      "supported_parameters": [
        "max_tokens",
        "temperature",
        "stop",
        "tools",
        "tool_choice",
        "reasoning",
        "include_reasoning"
      ],
      "reasoning_options": [
        {
          "type": "toggle"
        },
        {
          "type": "effort",
          "values": [
            "none",
            "minimal",
            "low",
            "medium",
            "high",
            "xhigh",
            "max"
          ]
        },
        {
          "type": "budget_tokens",
          "min": 1,
          "max": 81920
        }
      ],
      "pricing": {
        "input": "0.0000004",
        "input_tiers": [
          {
            "cost": "0.0000004",
            "min": 0,
            "max": 256001
          },
          {
            "cost": "0.0000005",
            "min": 256001
          }
        ],
        "output": "0.0000024",
        "output_tiers": [
          {
            "cost": "0.0000024",
            "min": 0,
            "max": 256001
          },
          {
            "cost": "0.000003",
            "min": 256001
          }
        ],
        "input_cache_read": "0.00000004",
        "input_cache_read_tiers": [
          {
            "cost": "0.00000004",
            "min": 0,
            "max": 256001
          },
          {
            "cost": "0.00000005",
            "min": 256001
          }
        ],
        "input_cache_write": "0.0000005",
        "input_cache_write_tiers": [
          {
            "cost": "0.0000005",
            "min": 0,
            "max": 256001
          },
          {
            "cost": "0.000000625",
            "min": 256001
          }
        ]
      }
    }
  ]
};
