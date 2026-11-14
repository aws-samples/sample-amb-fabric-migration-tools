# What Amazon Managed Blockchain does and does not provide for a migration

> Sample code, not an official AWS migration tool. See the [disclaimer](../README.md#disclaimer).

These constraints shape every plan this toolkit supports. They come from the AMB Hyperledger Fabric documentation and
from Hyperledger Fabric itself. Plan around them; none of them is a toolkit setting.

## Not available

| Capability | Consequence for the migration |
|---|---|
| **Suspending private-data purge** (`blockToLive`) for a migration window | A collection with `blockToLive > 0` keeps losing values on every peer while the channel commits blocks. Data already purged cannot be recovered. Extract early, keep the window short, and record which collections have lost values to `blockToLive`, having the data owner accept that loss in writing |
| **A network-wide export of private data** across members | Each member extracts the collections it belongs to from its own peer, and the outputs are combined with `merge`. No member can extract another member's private values |
| **Private-data values on Fabric 1.2 and 1.4** | `DeliverWithPrivateData` exists from Fabric 2.0. On a 1.x network only the hashes of private data can be extracted (Tier 3); the values cannot be migrated by any client-side route. See [Fabric version support](fabric-version-support.md) |
| **Downloading installed chaincode packages** | Rebuild every chaincode from its source for the destination, under the same name |
| **Ledger snapshots** | Fabric 2.3 and later only, so not available on AMB 1.2, 1.4 or 2.2 |
| **Upgrading `FrameworkVersion`** | Fixed when the network was created. The Fabric Gateway service (2.4+) is not available on AMB 2.2, so the toolkit uses the legacy SDK path |
| **Access to another member's private data through a temporary identity** | A peer only holds private data for collections it was a member of when the data was committed. Read access granted today delivers nothing that was never sent to that peer |

## Under your control

| Lever | Notes |
|---|---|
| **The peer node's instance type** | Extraction reads every block from the member's peer, and the peer's size sets how fast it serves them. Burstable instance types run out of CPU credit under sustained load; a peer that falls behind the orderer also delays extraction. The number of peers and the instance types available depend on the network edition |
| **Raising or zeroing `blockToLive`** | It is part of the collection configuration, so it changes with a chaincode definition update approved by every affected member. Keep the collection's membership and `memberOnlyRead` / `memberOnlyWrite` unchanged, or you change who can extract. It does not recover data already purged |
| **Peer logs in CloudWatch Logs** | Enable them per peer node for the extraction window; they help diagnose a refused query |
| **Stopping writes** | Purge advances with committed blocks, so a channel committing nothing advances no purge horizon. The cutover freeze freezes it for its own duration only |

References: [Peer nodes](https://docs.aws.amazon.com/managed-blockchain/latest/hyperledger-fabric-dev/managed-blockchain-hyperledger-peer-nodes.html),
[Private data collections](https://docs.aws.amazon.com/managed-blockchain/latest/hyperledger-fabric-dev/private-data-collections.html),
[Monitoring with CloudWatch Logs](https://docs.aws.amazon.com/managed-blockchain/latest/hyperledger-fabric-dev/monitoring-cloudwatch-logs.html),
[Quotas](https://docs.aws.amazon.com/general/latest/gr/managedblockchain.html).
