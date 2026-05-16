package localcorpus

import "github.com/nageoffer/ragent/go/retrievalexecutor/internal/domain/retrieval"

type corpusDocument struct {
	retrieval.Chunk
	Terms []string
}

func DefaultCorpus() []corpusDocument {
	return []corpusDocument{
		{
			Chunk: retrieval.Chunk{
				ChunkID:         "chunk_policy_leave",
				KnowledgeBaseID: "kb_policy",
				DocumentID:      "doc_policy_leave",
				Title:           "Leave Policy Overview",
				Content:         "Annual leave requests require manager approval and should be submitted three business days in advance.",
				Source:          retrieval.SourceLocalCorpus,
				Metadata: map[string]any{
					"department": "hr",
					"category":   "policy",
					"locale":     "en",
				},
			},
			Terms: []string{"leave", "vacation", "policy", "annual leave", "manager approval"},
		},
		{
			Chunk: retrieval.Chunk{
				ChunkID:         "chunk_policy_payroll",
				KnowledgeBaseID: "kb_policy",
				DocumentID:      "doc_policy_payroll",
				Title:           "Payroll and Benefits",
				Content:         "Payroll closes on the 25th of each month. Benefit enrollment changes take effect on the first day of the next month.",
				Source:          retrieval.SourceLocalCorpus,
				Metadata: map[string]any{
					"department": "finance",
					"category":   "policy",
					"locale":     "en",
				},
			},
			Terms: []string{"payroll", "benefits", "salary", "policy", "enrollment"},
		},
		{
			Chunk: retrieval.Chunk{
				ChunkID:         "chunk_ops_incident",
				KnowledgeBaseID: "kb_ops",
				DocumentID:      "doc_ops_incident",
				Title:           "Incident Response Runbook",
				Content:         "Priority 1 incidents require an incident commander, status updates every 15 minutes, and a follow-up review within 24 hours.",
				Source:          retrieval.SourceLocalCorpus,
				Metadata: map[string]any{
					"department": "ops",
					"category":   "runbook",
					"priority":   "p1",
				},
			},
			Terms: []string{"incident", "p1", "support", "runbook", "sla"},
		},
		{
			Chunk: retrieval.Chunk{
				ChunkID:         "chunk_ops_ticket",
				KnowledgeBaseID: "kb_ops",
				DocumentID:      "doc_ops_ticket",
				Title:           "Ticket Triage SOP",
				Content:         "Support tickets should be routed by product area, urgency, and customer tier before escalation.",
				Source:          retrieval.SourceLocalCorpus,
				Metadata: map[string]any{
					"department": "ops",
					"category":   "support",
					"priority":   "mixed",
				},
			},
			Terms: []string{"ticket", "support", "triage", "escalation", "ops"},
		},
		{
			Chunk: retrieval.Chunk{
				ChunkID:         "chunk_product_release",
				KnowledgeBaseID: "kb_product",
				DocumentID:      "doc_product_release",
				Title:           "Release Readiness Checklist",
				Content:         "Release readiness requires QA signoff, rollout notes, rollback guidance, and stakeholder communication.",
				Source:          retrieval.SourceLocalCorpus,
				Metadata: map[string]any{
					"department": "product",
					"category":   "release",
					"locale":     "en",
				},
			},
			Terms: []string{"release", "product", "feature", "roadmap", "rollout"},
		},
		{
			Chunk: retrieval.Chunk{
				ChunkID:         "chunk_product_roadmap",
				KnowledgeBaseID: "kb_product",
				DocumentID:      "doc_product_roadmap",
				Title:           "Product Planning Notes",
				Content:         "Roadmap reviews prioritize customer demand, implementation cost, and dependencies across teams.",
				Source:          retrieval.SourceLocalCorpus,
				Metadata: map[string]any{
					"department": "product",
					"category":   "planning",
					"locale":     "en",
				},
			},
			Terms: []string{"roadmap", "product", "feature", "planning", "dependencies"},
		},
	}
}
