const fs = require('fs');
let code = fs.readFileSync('supabase/functions/parametric-chat/index.ts', 'utf8');

// 1. Add Anthropic import
code = code.replace(
  `import { corsHeaders } from '../_shared/cors.ts';`,
  `import { corsHeaders } from '../_shared/cors.ts';\nimport Anthropic from 'npm:@anthropic-ai/sdk';`
);

// 2. Remove OpenRouter constants
code = code.replace(
  /\/\/ OpenRouter API configuration[\s\S]*?const OPENROUTER_API_KEY[^;]+;/g,
  `// Anthropic Setup\nconst ANTHROPIC_API_KEY = Deno.env.get('ANTHROPIC_API_KEY') ?? '';`
);

// 3. Remove OpenAIMessage and OpenRouterRequest interfaces
code = code.replace(/\/\/ Convert Anthropic-style message to OpenAI format[\s\S]*?interface OpenRouterRequest \{[\s\S]*?\}/g, '');

// 4. Update tools
code = code.replace(/const tools = \[[\s\S]*?\];/m, `const tools = [
  {
    name: 'build_parametric_model',
    description:
      'Generate or update an OpenSCAD model from user intent and context. Include parameters and ensure the model is manifold and 3D-printable.',
    input_schema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'User request for the model' },
        imageIds: {
          type: 'array',
          items: { type: 'string' },
          description: 'Image IDs to reference',
        },
        baseCode: { type: 'string', description: 'Existing code to modify' },
        error: { type: 'string', description: 'Error to fix' },
      },
    },
  },
  {
    name: 'apply_parameter_changes',
    description:
      'Apply simple parameter updates to the current artifact without re-generating the whole model.',
    input_schema: {
      type: 'object',
      properties: {
        updates: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              value: { type: 'string' },
            },
            required: ['name', 'value'],
          },
        },
      },
      required: ['updates'],
    },
  },
];`);

// 5. Update generateTitleFromMessages
code = code.replace(
  /async function generateTitleFromMessages\([\s\S]*?return 'Adam Object';\n\}/,
  `async function generateTitleFromMessages(messagesToSend: any[], anthropic: any): Promise<string> {
  try {
    const titleSystemPrompt = \`Generate a short title for a 3D object. Rules:
- Maximum 25 characters
- Just the object name, nothing else
- No explanations, notes, or commentary
- No quotes or special formatting
- Examples: "Coffee Mug", "Gear Assembly", "Phone Stand"\`;

    const response = await anthropic.messages.create({
      model: 'claude-3-haiku-20240307',
      max_tokens: 30,
      system: titleSystemPrompt,
      messages: [
        ...messagesToSend,
        { role: 'user', content: 'Title:' }
      ]
    });
    
    let title = response.content[0].text.trim();
    title = title.replace(/^["']|["']$/g, '').replace(/^title:\\s*/i, '').replace(/[.!?:;,]+$/, '');
    title = title.replace(/\\s*(note[s]?|here'?s?|based on|for the|this is).*$/i, '').trim();
    if (title.length > 27) title = title.substring(0, 24) + '...';
    if (title.length < 2) return 'Adam Object';
    return title;
  } catch(e) { 
    console.error('Title error', e); 
    return 'Adam Object'; 
  }
}`
);

// 6. Rewrite messages preparation
code = code.replace(
  /const messagesToSend: OpenAIMessage\[\] = await Promise\.all\([\s\S]*?\/\/ Prepare request body/,
  `const messagesToSend: any[] = await Promise.all(
      currentMessageBranch.map(async (msg: any) => {
        if (msg.role === 'user') {
          const formatted = await formatUserMessage(
            msg,
            supabaseClient,
            userData.user.id,
            conversationId,
          );
          return { role: 'user', content: formatted.content };
        }
        return {
          role: 'assistant',
          content: msg.content.artifact
            ? msg.content.artifact.code || ''
            : msg.content.text || '',
        };
      }),
    );
    
    const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
    
    // Prepare request body`
);

// 7. Rewrite the streaming fetch call
code = code.replace(
  /const requestBody: OpenRouterRequest = \{[\s\S]*?const responseStream = new ReadableStream\(\{/m,
  `const stream = await anthropic.messages.create({
      model: 'claude-3-5-sonnet-20241022',
      max_tokens: 8192,
      system: PARAMETRIC_AGENT_PROMPT,
      messages: messagesToSend,
      tools: tools as any,
      stream: true,
    });

    const responseStream = new ReadableStream({`
);

// 8. Rewrite stream parsing loop
code = code.replace(
  /try \{\n\s*const reader = response\.body\?\.getReader\(\)[\s\S]*?\}\n\s*\}\n\s*\} catch \(error\) \{/m,
  `try {
          for await (const chunk of stream) {
            if (chunk.type === 'content_block_start' && chunk.content_block.type === 'tool_use') {
              currentToolCall = {
                id: chunk.content_block.id,
                name: chunk.content_block.name,
                arguments: '',
              };
              content = {
                ...content,
                toolCalls: [
                  ...(content.toolCalls || []),
                  {
                    name: currentToolCall.name,
                    id: currentToolCall.id,
                    status: 'pending',
                  },
                ],
              };
              streamMessage(controller, { ...newMessageData, content });
            } else if (chunk.type === 'content_block_delta' && chunk.delta.type === 'text_delta') {
              content = {
                ...content,
                text: (content.text || '') + chunk.delta.text,
              };
              streamMessage(controller, { ...newMessageData, content });
            } else if (chunk.type === 'content_block_delta' && chunk.delta.type === 'input_json_delta') {
              if (currentToolCall) {
                currentToolCall.arguments += chunk.delta.partial_json;
              }
            } else if (chunk.type === 'content_block_stop') {
              if (currentToolCall) {
                await handleToolCall(currentToolCall);
                currentToolCall = null;
              }
            }
          }
        } catch (error) {`
);

// 9. Fix title generation
code = code.replace(
  /generateTitleFromMessages\(messagesToSend\)/g,
  `generateTitleFromMessages(messagesToSend, anthropic)`
);

// 10. Update inner code generation call logic
code = code.replace(
  /const codeRequestBody: OpenRouterRequest = \{[\s\S]*?const match = code\.match\(codeBlockRegex\);/m,
  `const [codeResult, titleResult] = await Promise.allSettled([
              anthropic.messages.create({
                model: 'claude-3-5-sonnet-20241022',
                system: STRICT_CODE_PROMPT,
                max_tokens: 8192,
                messages: codeMessages,
              }),
              generateTitleFromMessages(messagesToSend, anthropic),
            ]);

            let code = '';
            if (
              codeResult.status === 'fulfilled' &&
              codeResult.value.content[0].type === 'text'
            ) {
              code = codeResult.value.content[0].text.trim();
            } else if (codeResult.status === 'rejected') {
              console.error('Code generation failed:', codeResult.reason);
            }

            const codeBlockRegex = /^\`\`\`(?:openscad)?\\n?([\\s\\S]*?)\\n?\`\`\`$/;
            const match = code.match(codeBlockRegex);`
);

fs.writeFileSync('supabase/functions/parametric-chat/index.ts', code);
console.log('File rewritten safely!');
