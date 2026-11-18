// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

package main

import (
	"encoding/json"
	"fmt"
	"log"
	"os"
	"time"

	"github.com/aws-samples/sample-amb-fabric-migration-tools/sample/sample_assets/migration"
	"github.com/hyperledger/fabric-chaincode-go/shim"
	"github.com/hyperledger/fabric-contract-api-go/contractapi"
)

// SampleAssets is a chaincode that exercises every extraction path in the
// AMB Fabric migration toolkit. It manages two types of data:
//
//   - Public assets (PutState / DelState) — visible to all channel members
//   - Confidential appraisals (PutPrivateData) — scoped to specific orgs
//
// Two private data collections are configured:
//
//   - "orgPrivateData": persistent private data (blockToLive=0, never purged)
//   - "tempPrivateData": ephemeral private data (blockToLive=100, auto-purged)
//
// This exercises: public CRUD, private CRUD, deletes, overwrites, composite
// keys, multi-collection output, purge risk assessment, and hash extraction
// for purged private data.
type SampleAssets struct {
	contractapi.Contract
}

// Asset represents a public ledger asset.
type Asset struct {
	DocType  string `json:"docType"`
	ID       string `json:"id"`
	Owner    string `json:"owner"`
	Value    int    `json:"value"`
	Color    string `json:"color"`
	Size     int    `json:"size"`
	Modified string `json:"modified"`
}

// Appraisal represents a private appraisal of an asset.
type Appraisal struct {
	AssetID        string `json:"assetId"`
	AppraisedValue int    `json:"appraisedValue"`
	Appraiser      string `json:"appraiser"`
	Notes          string `json:"notes"`
	Timestamp      string `json:"timestamp"`
}

// ────────────────────────────────────────────────────────────────
// Public state operations
// ────────────────────────────────────────────────────────────────

// CreateAsset adds a new asset to the public ledger.
func (s *SampleAssets) CreateAsset(ctx contractapi.TransactionContextInterface,
	id string, owner string, value int, color string, size int) error {

	exists, err := s.AssetExists(ctx, id)
	if err != nil {
		return err
	}
	if exists {
		return fmt.Errorf("asset %s already exists", id)
	}

	asset := Asset{
		DocType:  "asset",
		ID:       id,
		Owner:    owner,
		Value:    value,
		Color:    color,
		Size:     size,
		Modified: time.Now().UTC().Format(time.RFC3339),
	}

	assetJSON, err := json.Marshal(asset)
	if err != nil {
		return fmt.Errorf("failed to marshal asset: %w", err)
	}

	// Main key
	if err := ctx.GetStub().PutState(id, assetJSON); err != nil {
		return fmt.Errorf("failed to put asset: %w", err)
	}

	// Composite key index: color~id (exercises composite key extraction)
	colorIdKey, err := ctx.GetStub().CreateCompositeKey("color~id", []string{color, id})
	if err != nil {
		return fmt.Errorf("failed to create composite key: %w", err)
	}
	// Store empty value — the composite key itself is the index entry
	if err := ctx.GetStub().PutState(colorIdKey, []byte{0x00}); err != nil {
		return fmt.Errorf("failed to put composite key: %w", err)
	}

	return nil
}

// UpdateAsset overwrites an existing asset (exercises state overwrite → only
// latest value appears in public_state, but all versions in public_history).
func (s *SampleAssets) UpdateAsset(ctx contractapi.TransactionContextInterface,
	id string, owner string, value int, color string, size int) error {

	exists, err := s.AssetExists(ctx, id)
	if err != nil {
		return err
	}
	if !exists {
		return fmt.Errorf("asset %s does not exist", id)
	}

	asset := Asset{
		DocType:  "asset",
		ID:       id,
		Owner:    owner,
		Value:    value,
		Color:    color,
		Size:     size,
		Modified: time.Now().UTC().Format(time.RFC3339),
	}

	assetJSON, err := json.Marshal(asset)
	if err != nil {
		return fmt.Errorf("failed to marshal asset: %w", err)
	}

	return ctx.GetStub().PutState(id, assetJSON)
}

// TransferAsset changes ownership (targeted overwrite — only owner field changes).
func (s *SampleAssets) TransferAsset(ctx contractapi.TransactionContextInterface,
	id string, newOwner string) error {

	assetJSON, err := ctx.GetStub().GetState(id)
	if err != nil {
		return fmt.Errorf("failed to read asset %s: %w", id, err)
	}
	if assetJSON == nil {
		return fmt.Errorf("asset %s does not exist", id)
	}

	var asset Asset
	if err := json.Unmarshal(assetJSON, &asset); err != nil {
		return fmt.Errorf("failed to unmarshal asset: %w", err)
	}

	asset.Owner = newOwner
	asset.Modified = time.Now().UTC().Format(time.RFC3339)

	updated, err := json.Marshal(asset)
	if err != nil {
		return fmt.Errorf("failed to marshal asset: %w", err)
	}

	return ctx.GetStub().PutState(id, updated)
}

// DeleteAsset removes an asset from the current state (exercises DelState →
// key absent from public_state but present in public_history with isDelete=true).
func (s *SampleAssets) DeleteAsset(ctx contractapi.TransactionContextInterface, id string) error {
	assetJSON, err := ctx.GetStub().GetState(id)
	if err != nil {
		return fmt.Errorf("failed to read asset %s: %w", id, err)
	}
	if assetJSON == nil {
		return fmt.Errorf("asset %s does not exist", id)
	}

	// Delete the main key
	if err := ctx.GetStub().DelState(id); err != nil {
		return fmt.Errorf("failed to delete asset %s: %w", id, err)
	}

	// Clean up composite key index
	var asset Asset
	if err := json.Unmarshal(assetJSON, &asset); err != nil {
		return fmt.Errorf("failed to unmarshal asset: %w", err)
	}

	colorIdKey, err := ctx.GetStub().CreateCompositeKey("color~id", []string{asset.Color, id})
	if err != nil {
		return fmt.Errorf("failed to create composite key: %w", err)
	}
	if err := ctx.GetStub().DelState(colorIdKey); err != nil {
		return fmt.Errorf("failed to delete composite key: %w", err)
	}

	return nil
}

// AssetExists checks whether an asset exists in the public ledger.
func (s *SampleAssets) AssetExists(ctx contractapi.TransactionContextInterface, id string) (bool, error) {
	assetJSON, err := ctx.GetStub().GetState(id)
	if err != nil {
		return false, fmt.Errorf("failed to read from world state: %w", err)
	}
	return assetJSON != nil, nil
}

// ReadAsset returns the current value of an asset.
func (s *SampleAssets) ReadAsset(ctx contractapi.TransactionContextInterface, id string) (*Asset, error) {
	assetJSON, err := ctx.GetStub().GetState(id)
	if err != nil {
		return nil, fmt.Errorf("failed to read asset %s: %w", id, err)
	}
	if assetJSON == nil {
		return nil, fmt.Errorf("asset %s does not exist", id)
	}

	var asset Asset
	if err := json.Unmarshal(assetJSON, &asset); err != nil {
		return nil, fmt.Errorf("failed to unmarshal asset: %w", err)
	}
	return &asset, nil
}

// ────────────────────────────────────────────────────────────────
// Private data operations
// ────────────────────────────────────────────────────────────────

// CreateAppraisal stores a private appraisal in the "orgPrivateData" collection.
// The appraisal value and notes are passed as transient data to keep them off
// the public ledger.
func (s *SampleAssets) CreateAppraisal(ctx contractapi.TransactionContextInterface) error {
	transient, err := ctx.GetStub().GetTransient()
	if err != nil {
		return fmt.Errorf("failed to get transient data: %w", err)
	}

	appraisalJSON, ok := transient["appraisal"]
	if !ok {
		return fmt.Errorf("appraisal not found in transient data")
	}

	var appraisal Appraisal
	if err := json.Unmarshal(appraisalJSON, &appraisal); err != nil {
		return fmt.Errorf("failed to unmarshal appraisal: %w", err)
	}

	appraisal.Timestamp = time.Now().UTC().Format(time.RFC3339)

	data, err := json.Marshal(appraisal)
	if err != nil {
		return fmt.Errorf("failed to marshal appraisal: %w", err)
	}

	// Persistent private collection (blockToLive=0)
	key := fmt.Sprintf("appraisal_%s", appraisal.AssetID)
	if err := ctx.GetStub().PutPrivateData("orgPrivateData", key, data); err != nil {
		return fmt.Errorf("failed to put private data: %w", err)
	}

	return nil
}

// CreateTempNote stores a temporary note in the "tempPrivateData" collection.
// This collection has blockToLive=100, so entries will be purged after ~100 blocks.
// After purging, only the hash remains — exercising the hash extraction path.
func (s *SampleAssets) CreateTempNote(ctx contractapi.TransactionContextInterface) error {
	transient, err := ctx.GetStub().GetTransient()
	if err != nil {
		return fmt.Errorf("failed to get transient data: %w", err)
	}

	noteJSON, ok := transient["note"]
	if !ok {
		return fmt.Errorf("note not found in transient data")
	}

	type TempNote struct {
		AssetID string `json:"assetId"`
		Note    string `json:"note"`
	}

	var note TempNote
	if err := json.Unmarshal(noteJSON, &note); err != nil {
		return fmt.Errorf("failed to unmarshal note: %w", err)
	}

	key := fmt.Sprintf("note_%s", note.AssetID)
	if err := ctx.GetStub().PutPrivateData("tempPrivateData", key, noteJSON); err != nil {
		return fmt.Errorf("failed to put temp private data: %w", err)
	}

	return nil
}

// UpdateAppraisal overwrites an existing appraisal (exercises private data overwrite).
func (s *SampleAssets) UpdateAppraisal(ctx contractapi.TransactionContextInterface) error {
	// Same as CreateAppraisal — PutPrivateData overwrites if key exists
	return s.CreateAppraisal(ctx)
}

// DeleteAppraisal removes a private appraisal (exercises DelPrivateData →
// key absent from private_state but present in private_history with isDelete=true).
func (s *SampleAssets) DeleteAppraisal(ctx contractapi.TransactionContextInterface, assetId string) error {
	key := fmt.Sprintf("appraisal_%s", assetId)
	return ctx.GetStub().DelPrivateData("orgPrivateData", key)
}

func main() {
	chaincode, err := contractapi.NewChaincode(
		&SampleAssets{},
		&migration.MigrationContract{},
	)
	if err != nil {
		log.Fatalf("Error creating sample_assets chaincode: %v", err)
	}

	// Chaincode as a service: when the peer's external builder starts us as a server
	// (CHAINCODE_SERVER_ADDRESS and CHAINCODE_ID set), listen instead of dialling the peer.
	if addr := os.Getenv("CHAINCODE_SERVER_ADDRESS"); addr != "" {
		server := &shim.ChaincodeServer{
			CCID:     os.Getenv("CHAINCODE_ID"),
			Address:  addr,
			CC:       chaincode,
			TLSProps: shim.TLSProperties{Disabled: true},
		}
		if err := server.Start(); err != nil {
			log.Fatalf("Error starting sample_assets chaincode server: %v", err)
		}
		return
	}

	if err := chaincode.Start(); err != nil {
		log.Fatalf("Error starting sample_assets chaincode: %v", err)
	}
}
