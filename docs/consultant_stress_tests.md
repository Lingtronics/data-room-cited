# Consultant Stress Tests

Use these scenarios to test whether the RAG tool helps a consultant work faster without hiding uncertainty. Each scenario includes a paste-ready prompt, what it stresses, and what a good answer should do.

## 1. Client Engagement Presentation Script

Situation: A Klarus consultant has 30 minutes before a client call and needs a first-pass talk track for a PowerPoint deck.

Prompt:

```text
Prepare a client-ready PowerPoint presentation script for a commercial due diligence readout on Meridian Analytics. Structure it as 8-10 slides with slide titles, speaker notes, the core message on each slide, and the evidence that supports each claim. Include market position, growth, customer quality, contract risks, management gaps, and open diligence questions.
```

What this stresses:
- Whole-corpus synthesis.
- Whether the model can produce a consultant-style storyline, not just facts.
- Whether citations support major claims.
- Whether the answer separates evidence from interpretation.

Good answer:
- Uses document/page/section citations for key claims.
- Calls out missing or weak evidence.
- Includes open diligence questions rather than pretending the data room is complete.
- Avoids unsupported consulting flourish.

Bad answer:
- Produces a generic SaaS investment memo without citations.
- Invents slide content not grounded in the documents.
- Treats generated context as evidence.

## 2. Partner Wants The "So What"

Situation: A partner asks for the five things that matter most before reading the data room.

Prompt:

```text
What are the five most important things a PE deal team should know about Meridian Analytics before diving into the detail? For each point, explain why it matters commercially and cite the source.
```

What this stresses:
- Prioritisation.
- Cross-document synthesis.
- Clear commercial reasoning.

Good answer:
- Ranks issues by likely investment relevance.
- Covers both upside and risks.
- Cites each point.
- Flags that the image-only/scanned PDF is not searchable if relevant.

## 3. Missing Information And Unclear Areas

Situation: A consultant needs to prepare a request list for management.

Prompt:

```text
What important diligence questions are not answered by the data room, or remain unclear? Group them by commercial, financial, customer, product, management, and legal/contract areas. For each gap, explain why it matters and cite the closest available evidence.
```

What this stresses:
- Honest handling of absence.
- Ability to infer gaps without making unsupported claims.
- Use of nearby evidence without overclaiming.

Good answer:
- Says what is missing, not just what is present.
- Uses "closest available evidence" carefully.
- Does not cite a document as proving something it does not actually prove.

## 4. Risk And Red Flag Sweep

Situation: A consultant is preparing a risk page for an investment committee memo.

Prompt:

```text
Identify the main commercial diligence risks or red flags in the Meridian Analytics data room. For each risk, provide the evidence, why it matters to a buyer, the likely diligence follow-up, and whether the risk is high, medium, or low based only on the documents.
```

What this stresses:
- Risk identification across financials, contracts, market, and management.
- Grounded severity assessment.
- Useful follow-up actions.

Good answer:
- Separates observed facts from risk interpretation.
- Includes contract concentration, renewal/opt-out exposure, profitability/runway, market positioning, and management coverage if supported.
- Avoids claiming definitive risk levels without evidence.

## 5. Inconsistency And Cross-Check Challenge

Situation: A senior consultant asks whether the data room contradicts itself.

Prompt:

```text
Look for inconsistencies, tensions, or numbers that should be cross-checked across the Meridian documents. Focus on ARR, revenue growth, customer concentration, market sizing, contract terms, runway, and management claims. For each item, cite the relevant source text and say whether it is a true inconsistency or just something to verify.
```

What this stresses:
- Cross-document comparison.
- Careful language around "inconsistent" versus "needs verification".
- Numerical and contractual precision.

Good answer:
- Does not force contradictions where the documents are merely incomplete.
- Points to exact figures and documents.
- Produces a practical verification list.

## 6. CFO Numbers Sanity Check

Situation: A consultant is reviewing whether the numbers hang together.

Prompt:

```text
Do a CFO-style sanity check of the financial picture. Summarise ARR, recognised revenue, growth, gross margin, EBITDA, cash, burn, runway, and breakeven plan. Flag anything that needs reconciliation or additional backup.
```

What this stresses:
- Financial extraction.
- Use of multiple financial metrics without conflating ARR and revenue.
- Missing-data awareness.

Good answer:
- Keeps ARR distinct from recognised revenue.
- Mentions runway assumptions.
- Flags lack of cohort, churn, pipeline conversion, or forecast backup if not present.

## 7. Customer And Contract Exposure

Situation: The deal team wants to know whether revenue quality is robust.

Prompt:

```text
Assess Meridian's customer and contract quality. Cover concentration, top customer exposure, renewal/opt-out risk, contract duration, expansion quality, and any pipeline evidence. End with the top five follow-up questions for management.
```

What this stresses:
- Legal/commercial contract reading.
- Concentration risk.
- Follow-up question quality.

Good answer:
- Cites top-10 ARR concentration and named contracts.
- Distinguishes locked-in contracts from contracts with near-term opt-out windows.
- Avoids treating pipeline as closed revenue.

## 8. Management Quality And Organisation Risk

Situation: A consultant is drafting the management assessment section.

Prompt:

```text
What can we infer about Meridian's management quality and organisation risk from the data room? Include founder background, leadership gaps, product/technical leadership, and any missing evidence a buyer should request.
```

What this stresses:
- Synthesising qualitative management evidence.
- Staying honest when evidence is thin.
- Identifying gaps without inventing management biographies.

Good answer:
- Cites founder and leadership facts.
- Flags CTO vacancy or interim coverage if supported.
- Says what cannot be assessed from the provided documents.

## 9. Adversarial Partner Review

Situation: A skeptical partner challenges the consultant's emerging positive thesis.

Prompt:

```text
Argue against investing in Meridian Analytics using only the data room evidence. Build the strongest bear case, cite each major point, and include what evidence would change your mind.
```

What this stresses:
- Ability to reason directionally while staying grounded.
- Avoiding a one-sided optimistic summary.
- Evidence-based uncertainty.

Good answer:
- Produces a plausible bear case from actual documents.
- Names evidence that would reduce concern.
- Does not invent negative facts.

## 10. Source Audit

Situation: A consultant wants to check whether the answer can be trusted before pasting it into work product.

Prompt:

```text
For the previous answer, audit the support. List each major factual claim, the citation that supports it, and whether the citation fully supports the claim, partially supports it, or does not support it.
```

What this stresses:
- Citation discipline.
- Whether the tool can explain its own grounding.
- Weakness in conversational memory, because the current app does not store structured previous answers.

Good answer:
- If conversational context is unavailable, says so and asks the user to paste the previous answer.
- Does not fabricate an audit of an answer it cannot see.

## Demo Notes

- The strongest demos are broad questions that need synthesis plus a few targeted follow-ups.
- The tool is strongest on text-extracted PDFs.
- The tool deliberately warns when a PDF produces zero chunks; scanned PDFs need OCR before they can be included.
- The model can synthesise, but source-of-truth controls live in code: chunking, retrieval, context boundaries, citation verification, and fallback behavior.
