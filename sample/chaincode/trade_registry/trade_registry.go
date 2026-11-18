// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

package main

import (
	"encoding/json"
	"fmt"
	"log"
	"os"
	"time"

	"github.com/aws-samples/sample-amb-fabric-migration-tools/sample/trade_registry/migration"
	"github.com/hyperledger/fabric-chaincode-go/shim"
	"github.com/hyperledger/fabric-contract-api-go/contractapi"
)

// TradeRegistry manages trade records between counterparties.
// Exercises the same extraction paths as SampleAssets but with
// a different domain, key format, and private data pattern.
//
// Key format: "TRD-<id>" (vs plain "<id>" in sample_assets)
//
// Private data collection:
//   - "counterpartyDetails": persistent (blockToLive=0), stores
//     confidential settlement instructions per trade
type TradeRegistry struct {
	contractapi.Contract
}

// Trade represents a public trade record.
type Trade struct {
	DocType    string `json:"docType"`
	TradeID    string `json:"tradeId"`
	Buyer      string `json:"buyer"`
	Seller     string `json:"seller"`
	Asset      string `json:"asset"`
	Quantity   int    `json:"quantity"`
	PriceUSD   int    `json:"priceUsd"`
	Status     string `json:"status"`
	ExecutedAt string `json:"executedAt"`
	ModifiedAt string `json:"modifiedAt"`
}

// CounterpartyInfo holds private settlement details.
type CounterpartyInfo struct {
	TradeID    string `json:"tradeId"`
	Account    string `json:"account"`
	Routing    string `json:"routing"`
	Contact    string `json:"contact"`
	RecordedAt string `json:"recordedAt"`
}

func tradeKey(id string) string {
	return "TRD-" + id
}

// RegisterTrade creates a new trade record on the public ledger.
func (t *TradeRegistry) RegisterTrade(
	ctx contractapi.TransactionContextInterface,
	id string, buyer string, seller string,
	asset string, quantity int, priceUsd int,
) error {
	key := tradeKey(id)

	existing, err := ctx.GetStub().GetState(key)
	if err != nil {
		return fmt.Errorf("failed to read state: %w", err)
	}
	if existing != nil {
		return fmt.Errorf("trade %s already exists", id)
	}

	now := time.Now().UTC().Format(time.RFC3339)
	trade := Trade{
		DocType:    "trade",
		TradeID:    id,
		Buyer:      buyer,
		Seller:     seller,
		Asset:      asset,
		Quantity:   quantity,
		PriceUSD:   priceUsd,
		Status:     "OPEN",
		ExecutedAt: now,
		ModifiedAt: now,
	}

	data, err := json.Marshal(trade)
	if err != nil {
		return fmt.Errorf("failed to marshal trade: %w", err)
	}

	if err := ctx.GetStub().PutState(key, data); err != nil {
		return fmt.Errorf("failed to put trade: %w", err)
	}

	indexKey, err := ctx.GetStub().CreateCompositeKey(
		"status~id", []string{trade.Status, id},
	)
	if err != nil {
		return fmt.Errorf("failed to create composite key: %w", err)
	}
	return ctx.GetStub().PutState(indexKey, []byte{0x00})
}

// UpdateTrade modifies quantity and price on an open trade.
func (t *TradeRegistry) UpdateTrade(
	ctx contractapi.TransactionContextInterface,
	id string, quantity int, priceUsd int,
) error {
	key := tradeKey(id)
	data, err := ctx.GetStub().GetState(key)
	if err != nil {
		return fmt.Errorf("failed to read trade %s: %w", id, err)
	}
	if data == nil {
		return fmt.Errorf("trade %s does not exist", id)
	}

	var trade Trade
	if err := json.Unmarshal(data, &trade); err != nil {
		return fmt.Errorf("failed to unmarshal trade: %w", err)
	}
	if trade.Status != "OPEN" {
		return fmt.Errorf("cannot update trade %s: status is %s", id, trade.Status)
	}

	trade.Quantity = quantity
	trade.PriceUSD = priceUsd
	trade.ModifiedAt = time.Now().UTC().Format(time.RFC3339)

	updated, err := json.Marshal(trade)
	if err != nil {
		return fmt.Errorf("failed to marshal trade: %w", err)
	}
	return ctx.GetStub().PutState(key, updated)
}

// CloseTrade marks a trade as SETTLED and removes the OPEN index.
func (t *TradeRegistry) CloseTrade(
	ctx contractapi.TransactionContextInterface,
	id string,
) error {
	key := tradeKey(id)
	data, err := ctx.GetStub().GetState(key)
	if err != nil {
		return fmt.Errorf("failed to read trade %s: %w", id, err)
	}
	if data == nil {
		return fmt.Errorf("trade %s does not exist", id)
	}

	var trade Trade
	if err := json.Unmarshal(data, &trade); err != nil {
		return fmt.Errorf("failed to unmarshal trade: %w", err)
	}

	oldStatus := trade.Status
	trade.Status = "SETTLED"
	trade.ModifiedAt = time.Now().UTC().Format(time.RFC3339)

	updated, err := json.Marshal(trade)
	if err != nil {
		return fmt.Errorf("failed to marshal trade: %w", err)
	}
	if err := ctx.GetStub().PutState(key, updated); err != nil {
		return fmt.Errorf("failed to put trade: %w", err)
	}

	oldIndexKey, err := ctx.GetStub().CreateCompositeKey(
		"status~id", []string{oldStatus, id},
	)
	if err != nil {
		return fmt.Errorf("failed to create old composite key: %w", err)
	}
	if err := ctx.GetStub().DelState(oldIndexKey); err != nil {
		return fmt.Errorf("failed to delete old index: %w", err)
	}

	newIndexKey, err := ctx.GetStub().CreateCompositeKey(
		"status~id", []string{"SETTLED", id},
	)
	if err != nil {
		return fmt.Errorf("failed to create new composite key: %w", err)
	}
	return ctx.GetStub().PutState(newIndexKey, []byte{0x00})
}

// CancelTrade deletes a trade entirely (exercises DelState).
func (t *TradeRegistry) CancelTrade(
	ctx contractapi.TransactionContextInterface,
	id string,
) error {
	key := tradeKey(id)
	data, err := ctx.GetStub().GetState(key)
	if err != nil {
		return fmt.Errorf("failed to read trade %s: %w", id, err)
	}
	if data == nil {
		return fmt.Errorf("trade %s does not exist", id)
	}

	var trade Trade
	if err := json.Unmarshal(data, &trade); err != nil {
		return fmt.Errorf("failed to unmarshal trade: %w", err)
	}

	if err := ctx.GetStub().DelState(key); err != nil {
		return fmt.Errorf("failed to delete trade %s: %w", id, err)
	}

	indexKey, err := ctx.GetStub().CreateCompositeKey(
		"status~id", []string{trade.Status, id},
	)
	if err != nil {
		return fmt.Errorf("failed to create composite key: %w", err)
	}
	return ctx.GetStub().DelState(indexKey)
}

// ReadTrade returns the current value of a trade.
func (t *TradeRegistry) ReadTrade(
	ctx contractapi.TransactionContextInterface,
	id string,
) (*Trade, error) {
	data, err := ctx.GetStub().GetState(tradeKey(id))
	if err != nil {
		return nil, fmt.Errorf("failed to read trade %s: %w", id, err)
	}
	if data == nil {
		return nil, fmt.Errorf("trade %s does not exist", id)
	}

	var trade Trade
	if err := json.Unmarshal(data, &trade); err != nil {
		return nil, fmt.Errorf("failed to unmarshal trade: %w", err)
	}
	return &trade, nil
}

// SetCounterpartyInfo stores private settlement details via transient data.
func (t *TradeRegistry) SetCounterpartyInfo(
	ctx contractapi.TransactionContextInterface,
) error {
	transient, err := ctx.GetStub().GetTransient()
	if err != nil {
		return fmt.Errorf("failed to get transient data: %w", err)
	}

	infoJSON, ok := transient["counterparty"]
	if !ok {
		return fmt.Errorf("counterparty not found in transient data")
	}

	var info CounterpartyInfo
	if err := json.Unmarshal(infoJSON, &info); err != nil {
		return fmt.Errorf("failed to unmarshal counterparty info: %w", err)
	}

	info.RecordedAt = time.Now().UTC().Format(time.RFC3339)

	data, err := json.Marshal(info)
	if err != nil {
		return fmt.Errorf("failed to marshal counterparty info: %w", err)
	}

	key := fmt.Sprintf("cpty_%s", info.TradeID)
	return ctx.GetStub().PutPrivateData(
		"counterpartyDetails", key, data,
	)
}

// DeleteCounterpartyInfo removes private settlement details.
func (t *TradeRegistry) DeleteCounterpartyInfo(
	ctx contractapi.TransactionContextInterface,
	tradeId string,
) error {
	key := fmt.Sprintf("cpty_%s", tradeId)
	return ctx.GetStub().DelPrivateData("counterpartyDetails", key)
}

func main() {
	chaincode, err := contractapi.NewChaincode(
		&TradeRegistry{},
		&migration.MigrationContract{},
	)
	if err != nil {
		log.Fatalf("Error creating trade_registry chaincode: %v", err)
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
			log.Fatalf("Error starting trade_registry chaincode server: %v", err)
		}
		return
	}

	if err := chaincode.Start(); err != nil {
		log.Fatalf("Error starting trade_registry chaincode: %v", err)
	}
}
