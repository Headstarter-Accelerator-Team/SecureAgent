import { ChatCompletionMessageParam } from "groq-sdk/resources/chat/completions";
import { PRSuggestion } from "../constants";

export const INLINE_FIX_PROMPT = `In this task, you are provided with a code suggestion in XML format, along with the corresponding file content. Your task is to radiate from this suggestion and draft a precise code fix. Here's how your input will look:

\`\`\`xml
  <suggestion>
    <describe>Your Description Here</describe>
    <type>Your Type Here</type>
    <comment>Your Suggestions Here</comment>
    <code>Original Code Here</code>
    <filename>File Name Here</filename>
  </suggestion>
\`\`\`

{file}

The 'comment' field contains specific code modification instructions. Based on these instructions, you're required to formulate a precise code fix. Bear in mind that the fix must include only the lines between the starting line (linestart) and ending line (lineend) where the changes are applied.

The adjusted code doesn’t necessarily need to be standalone valid code but must seamlessly integrate into the corresponding file content when applied. This means the modified snippet, when inserted into the file, should result in valid, functional code without introducing errors or breaking existing functionality.

When drafting the fix:

  1. Specificity: Include only the specific lines affected by the modification, ensuring they fully reflect the changes described in the suggestion. Avoid adding extra context or surrounding lines unless explicitly necessary for clarity or correctness.

  2. Precision: Avoid placeholders like "rest of code..." or ambiguous instructions that might leave room for interpretation. Each line of the fix should be clear, purposeful, and directly actionable.
  
  3. Consistency: Ensure the changes conform to the coding style and conventions present in the provided file content. If no style is apparent, apply generally accepted best practices.
  
  4. Validation: Assume the file content provided represents the exact state of the file where the fix will be applied. Double-check that the changes address the suggestion without conflicting with the surrounding code or introducing syntax, logical, or runtime errors.

Please interpret the instructions provided in the 'comment' field, along with the contextual file content, to implement a targeted and accurate code fix. Your output will be utilized in an inline suggestion on GitHub, so ensure it is concise, unambiguous, and directly resolves the issue described.`;

export const INLINE_FIX_FUNCTION = {
  name: "fix",
  description: "The code fix to address the suggestion and rectify the issue",
  parameters: {
    type: "object",
    properties: {
      comment: {
        type: "string",
        description: "Why this change improves the code",
      },
      code: {
        type: "string",
        description: "Modified Code Snippet",
      },
      lineStart: {
        type: "number",
        description: "Starting Line Number",
      },
      lineEnd: {
        type: "number",
        description: "Ending Line Number",
      },
    },
  },
  required: ["action"],
};

const INLINE_USER_MESSAGE_TEMPLATE = `{SUGGESTION}

{FILE}`;

const assignFullLineNumers = (contents: string): string => {
  const lines = contents.split("\n");
  let lineNumber = 1;
  const linesWithNumbers = lines.map((line) => {
    const numberedLine = `${lineNumber}: ${line}`;
    lineNumber++;
    return numberedLine;
  });
  return linesWithNumbers.join("\n");
};

export const getInlineFixPrompt = (
  fileContents: string,
  suggestion: PRSuggestion
): ChatCompletionMessageParam[] => {
  const userMessage = INLINE_USER_MESSAGE_TEMPLATE.replace(
    "{SUGGESTION}",
    suggestion.toString()
  ).replace("{FILE}", assignFullLineNumers(fileContents));
  return [
    { role: "system", content: INLINE_FIX_PROMPT },
    { role: "user", content: userMessage },
  ];
};
