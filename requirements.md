Design and implement an automated daily cyber security news aggregation system that compiles content from a user-maintained list of sources. The system must execute daily using GitHub Actions, generate daily news as a GitHub Page, and support email subscription. If backend services are required, they must be implemented using Cloudflare Workers. AI tool integration is optional; if needed, the system should use free tier AI services. The solution should include the following components:

1. A structured method for maintaining and updating the list of cyber security news sources
2. Automated daily retrieval of content from specified sources
3. Content extraction and filtering mechanisms to focus on relevant cyber security topics
4. Aggregation and formatting of retrieved news into a coherent output format
5. Scheduling configuration for daily execution via GitHub Actions
6. Error handling and logging for failed source connections or content retrieval
7. GitHub Pages output generation: build and publish daily news compilations as static GitHub Pages, including HTML rendering with date-based navigation and historical archives
8. Email subscription mechanism via Resend (https://resend.com):
   - A subscription management interface or configuration for users to subscribe/unsubscribe
   - Automated daily email delivery of news summaries or full content via Resend API (free tier: 3,000 emails/month, 100/day)
   - Subscription list storage and management
9. Cloudflare Worker backend (if backend logic is required):
   - Serverless API endpoints for subscription management, source list updates, or dynamic content delivery
   - Edge-side caching and rate limiting for resilience and security
   - Integration with GitHub Pages and Resend email workflows
10. Recommended free AI tools (optional, for content processing tasks):
    - Content summarization: Llama 3 via Groq free tier, Qwen 2 via Alibaba Cloud free tier, or Hugging Face Inference API (free tier)
    - Text classification / topic filtering: Hugging Face zero-shot classification models (e.g., facebook/bart-large-mnli) via free inference API
    - Translation (if multilingual support is needed): Google Translate free tier, DeepL free tier, or NLLB models via Hugging Face
    - Content quality filtering: DistilBERT-based classification models via Hugging Face Inference API

The system should be designed for reliability, with appropriate retry mechanisms for transient network issues, and should produce consistent, readable news compilations on a daily basis without manual intervention.
