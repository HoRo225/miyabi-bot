export type PromptMessageRef = {
  id: string;
  channelId?: string;
  authorId: string;
  authorName: string | null;
  content: string;
  createdAt: string;
  attachments?: string[];
  imageUrls?: string[];
  attachmentExtractions?: string[];
};
