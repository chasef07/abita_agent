package scheduling_test

import (
	"advancedmd-token-management/internal/advancedmd/advancedmdtest"
	"advancedmd-token-management/internal/domain"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"advancedmd-token-management/internal/advancedmd"
	apphttp "advancedmd-token-management/internal/http"
	"advancedmd-token-management/internal/patient"
	"advancedmd-token-management/internal/safeerrors"
	"advancedmd-token-management/internal/scheduling"
)

// This explicitly opted-in test runs the real TypeScript call owner against Go HTTP
// handlers with only AdvancedMD replaced by a test adapter.
func TestTypeScriptSchedulingContract(t *testing.T) {
	typescript := os.Getenv("TYPESCRIPT_SCHEDULING_WORKTREE")
	if typescript == "" {
		t.Skip("set TYPESCRIPT_SCHEDULING_WORKTREE to run the cross-repository contract")
	}
	for _, scenario := range []string{"success", "partial", "failure", "uncertain"} {
		t.Run(scenario, func(t *testing.T) {
			records, _, _ := rescheduleFixture(t)
			records.Demographics["12345"] = domain.PatientDemographics{FullName: "DOE,JANE", DOB: "01/15/1980"}
			if scenario == "partial" {
				records.CancelAppointmentErr = context.DeadlineExceeded
			}
			if scenario == "failure" {
				records.BookAppointmentErr = context.DeadlineExceeded
			}
			for i := 1; i <= 16; i++ {
				day := mutationTestNow().AddDate(0, 0, i).Format("2006-01-02")
				records.ScheduleReads[day] = completeRead("1513", nil, nil)
			}
			var provider advancedmd.SchedulingRecords = records
			if scenario == "uncertain" {
				records.BookAppointmentErr = advancedmd.NewAmbiguousWriteError(safeerrors.CategoryTimeout)
				provider = &failReconciliation{Adapter: records}
			}
			scheduler := scheduling.New(provider, "test-booking-secret", mutationTestNow)
			tokens := scheduling.NewAppointmentTokens("test-booking-secret", mutationTestNow)
			router := apphttp.NewRouter(apphttp.NewHandlers(nil, patient.NewWithAppointmentTokens(records, tokens), scheduler), "test-auth", nil)
			mux := http.NewServeMux()
			mux.Handle("/", router)
			// Only scenario and clock control are fixtures. Patient appointments
			// and their action tokens must come through the real HTTP response.
			mux.HandleFunc("/fixture", func(w http.ResponseWriter, r *http.Request) {
				json.NewEncoder(w).Encode(map[string]any{
					"now": mutationTestNow().Format(time.RFC3339), "scenario": scenario,
				})
			})
			server := httptest.NewServer(mux)
			defer server.Close()
			cmd := exec.Command("corepack", "pnpm", "exec", "tsx", filepath.Join("scripts", "contracts", "middleware-contract.ts"), server.URL)
			cmd.Dir = typescript
			output, err := cmd.CombinedOutput()
			if err != nil {
				t.Fatalf("TypeScript contract: %v\n%s", err, output)
			}
			t.Log(string(output))
			wantCancel := 1
			if scenario == "failure" || scenario == "uncertain" {
				wantCancel = 0
			}
			if len(records.Bookings) != 1 || len(records.Cancellations) != wantCancel {
				t.Fatalf("provider writes=%d/%d", len(records.Bookings), len(records.Cancellations))
			}
		})
	}
}

// Capture the selection boundary, including discarded records and incomplete reads.
func TestTypeScriptPatientContract(t *testing.T) {
	root := os.Getenv("TYPESCRIPT_SCHEDULING_WORKTREE")
	if root == "" {
		t.Skip("set TYPESCRIPT_SCHEDULING_WORKTREE")
	}
	domain.InitRegistry("")
	valid := domain.Patient{ID: "1", FirstName: "Jane", LastName: "Meyer", FullName: "MEYER,JANE", DOB: "01/01/1980"}
	missing := domain.Patient{ID: "2", FirstName: "Jane", LastName: "Other", FullName: "OTHER,JANE"}
	fixtures := map[string]json.RawMessage{}
	for _, scenario := range []string{"unique", "not_found", "multiple_matches", "incomplete", "provider_failure"} {
		records := advancedmdtest.NewAdapter()
		rows := []domain.Patient{valid, missing}
		if scenario == "not_found" {
			rows = []domain.Patient{missing}
		}
		if scenario == "multiple_matches" {
			second := missing
			second.DOB = valid.DOB
			rows = append(rows, second)
		}
		records.CandidateReads["Jane"] = domain.PatientCandidateRead{Patients: rows, Complete: scenario != "incomplete"}
		if scenario == "provider_failure" {
			records.CandidateReadErrors["Jane"] = context.DeadlineExceeded
		}
		records.Demographics["1"] = domain.PatientDemographics{FullName: valid.FullName, DOB: valid.DOB}
		router := apphttp.NewRouter(apphttp.NewHandlers(nil, patient.New(records), nil), "test-auth", nil)
		req := httptest.NewRequest(http.MethodPost, "/api/patient/resolve", strings.NewReader(`{"office":"Spring Hill","firstName":"Jane","dob":"01/01/1980"}`))
		req.Header.Set("Authorization", "test-auth")
		response := httptest.NewRecorder()
		router.ServeHTTP(response, req)
		if response.Code != 200 {
			t.Fatal(response.Code, response.Body.String())
		}
		fixtures[scenario] = json.RawMessage(response.Body.Bytes())
	}
	data, err := json.MarshalIndent(fixtures, "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "src", "__tests__", "fixtures", "scheduling", "patient-resolution.json"), append(data, '\n'), 0644); err != nil {
		t.Fatal(err)
	}
}
