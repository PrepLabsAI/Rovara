// Spec 061 slice 2: the owner's answers and the comments they sent with a decision, as the next step reads them (the
// Markdown copy, the planner's prompt), and the sentence a page decision that came too late is refused with (FR-035).
export { pageCommentsPrompt, pageCommentsPromptSection, promptComments, type PromptComment } from "./page-comment-prompt.js";
import { commentAuthorLabel, ownerAnswersSentence, planOwnerAnswers } from "./owner-answers-text.js";

export { commentAuthorLabel, ownerAnswersSentence, planOwnerAnswers };


