package main

import (
	"encoding/json"
	"fmt"
	"log"
	"os"
	"strconv"
	"strings"

	"github.com/aws-samples/sample-amb-fabric-migration-tools/sample/consortium_ledger/migration"
	"github.com/hyperledger/fabric-chaincode-go/shim"
	"github.com/hyperledger/fabric-contract-api-go/contractapi"
)

// ConsortiumLedger is the load-bearing chaincode for the multi-member live test.
//
// It is deliberately generic rather than an application: every function is a
// thin wrapper over one ledger primitive, so a load generator can drive the
// shapes extraction and replay have to survive — deep per-key history, deletes,
// non-UTF-8 values, composite keys, large values, read-modify-write conflicts,
// and private data in collections each member sees differently — at whatever
// volume the test needs.
//
// Writes are blind (no GetState) except Incr, so concurrent submitters do not
// invalidate each other through MVCC; Incr exists to produce invalid
// transactions on purpose, which extraction must skip.
//
// Collections are rendered per channel by the multi-member harness from the
// channel's member list (sample/scripts/multi-member/collections.sh):
//
//   - allOrgs:   every channel member
//   - pairAB:    the first two members — on a three-member channel the third
//                sees hashes only
//   - onlyA:     the first member alone
//   - ephemeral: every member, blockToLive 40, so a deep ledger purges it
//
// Each member's _implicit_org_<MSPID> collection is written too.
type ConsortiumLedger struct {
	contractapi.Contract
}

// record is the JSON shape PutMany and PutPrivateMany write. TxID makes every
// version of a key distinct, so history comparison cannot pass by coincidence.
type record struct {
	Key   string `json:"key"`
	Round int    `json:"round"`
	TxID  string `json:"txId"`
	Pad   string `json:"pad,omitempty"`
}

func pad(size int) string {
	if size <= 0 {
		return ""
	}
	return strings.Repeat("x", size)
}

func generated(ctx contractapi.TransactionContextInterface, key string, round, size int) ([]byte, error) {
	return json.Marshal(record{
		Key: key, Round: round, TxID: ctx.GetStub().GetTxID(), Pad: pad(size),
	})
}

func manyKey(prefix string, i int) string {
	return fmt.Sprintf("%s-%06d", prefix, i)
}

// Put writes one public value.
func (c *ConsortiumLedger) Put(ctx contractapi.TransactionContextInterface, key, value string) error {
	return ctx.GetStub().PutState(key, []byte(value))
}

// PutMany writes count generated public values, keys prefix-<start..start+count).
func (c *ConsortiumLedger) PutMany(ctx contractapi.TransactionContextInterface,
	prefix string, start, count, size, round int) error {
	for i := start; i < start+count; i++ {
		key := manyKey(prefix, i)
		value, err := generated(ctx, key, round, size)
		if err != nil {
			return err
		}
		if err := ctx.GetStub().PutState(key, value); err != nil {
			return err
		}
	}
	return nil
}

// DeleteMany deletes keys prefix-<start..start+count) without reading them.
func (c *ConsortiumLedger) DeleteMany(ctx contractapi.TransactionContextInterface,
	prefix string, start, count int) error {
	for i := start; i < start+count; i++ {
		if err := ctx.GetStub().DelState(manyKey(prefix, i)); err != nil {
			return err
		}
	}
	return nil
}

// Delete removes one public key without reading it.
func (c *ConsortiumLedger) Delete(ctx contractapi.TransactionContextInterface, key string) error {
	return ctx.GetStub().DelState(key)
}

// PutBinary writes the transient "bin" bytes verbatim, so a value that is not
// valid UTF-8 reaches the ledger without passing through a string argument.
func (c *ConsortiumLedger) PutBinary(ctx contractapi.TransactionContextInterface, key string) error {
	transient, err := ctx.GetStub().GetTransient()
	if err != nil {
		return err
	}
	bin, ok := transient["bin"]
	if !ok {
		return fmt.Errorf("transient field bin is required")
	}
	return ctx.GetStub().PutState(key, bin)
}

// PutComposite writes a value under a composite key, which carries U+0000.
func (c *ConsortiumLedger) PutComposite(ctx contractapi.TransactionContextInterface,
	objectType, a, b, value string) error {
	key, err := ctx.GetStub().CreateCompositeKey(objectType, []string{a, b})
	if err != nil {
		return err
	}
	return ctx.GetStub().PutState(key, []byte(value))
}

// Incr is a read-modify-write counter. Concurrent calls on one key conflict and
// all but one commit as MVCC_READ_CONFLICT — invalid transactions in the
// ledger, which extraction must not apply.
func (c *ConsortiumLedger) Incr(ctx contractapi.TransactionContextInterface, key string) error {
	current, err := ctx.GetStub().GetState(key)
	if err != nil {
		return err
	}
	n := 0
	if len(current) > 0 {
		if n, err = strconv.Atoi(string(current)); err != nil {
			return fmt.Errorf("counter %s holds %q: %v", key, current, err)
		}
	}
	return ctx.GetStub().PutState(key, []byte(strconv.Itoa(n+1)))
}

// PutPrivate writes the transient "val" bytes into a collection.
func (c *ConsortiumLedger) PutPrivate(ctx contractapi.TransactionContextInterface,
	collection, key string) error {
	transient, err := ctx.GetStub().GetTransient()
	if err != nil {
		return err
	}
	val, ok := transient["val"]
	if !ok {
		return fmt.Errorf("transient field val is required")
	}
	return ctx.GetStub().PutPrivateData(collection, key, val)
}

// PutPrivateMany writes count generated private values into a collection.
// Generated on the endorser, so no value travels in the proposal at all.
func (c *ConsortiumLedger) PutPrivateMany(ctx contractapi.TransactionContextInterface,
	collection, prefix string, start, count, size, round int) error {
	for i := start; i < start+count; i++ {
		key := manyKey(prefix, i)
		value, err := generated(ctx, key, round, size)
		if err != nil {
			return err
		}
		if err := ctx.GetStub().PutPrivateData(collection, key, value); err != nil {
			return err
		}
	}
	return nil
}

// DeletePrivateMany deletes private keys prefix-<start..start+count).
func (c *ConsortiumLedger) DeletePrivateMany(ctx contractapi.TransactionContextInterface,
	collection, prefix string, start, count int) error {
	for i := start; i < start+count; i++ {
		if err := ctx.GetStub().DelPrivateData(collection, manyKey(prefix, i)); err != nil {
			return err
		}
	}
	return nil
}

// Get reads one public value, for spot checks during population.
func (c *ConsortiumLedger) Get(ctx contractapi.TransactionContextInterface, key string) (string, error) {
	value, err := ctx.GetStub().GetState(key)
	if err != nil {
		return "", err
	}
	return string(value), nil
}

func main() {
	chaincode, err := contractapi.NewChaincode(
		&ConsortiumLedger{},
		&migration.MigrationContract{},
	)
	if err != nil {
		log.Fatalf("Error creating consortium_ledger chaincode: %v", err)
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
			log.Fatalf("Error starting consortium_ledger chaincode server: %v", err)
		}
		return
	}

	if err := chaincode.Start(); err != nil {
		log.Fatalf("Error starting consortium_ledger chaincode: %v", err)
	}
}
