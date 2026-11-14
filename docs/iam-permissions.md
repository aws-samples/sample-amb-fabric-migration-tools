# IAM Permissions

> Sample code, not an official AWS migration tool. See the [disclaimer](../README.md#disclaimer).

Minimum IAM permissions for each phase of the migration toolkit. All phases use
the default AWS credential provider chain (environment variables, instance
profile, SSO, etc.).

## Extraction (required)

The extraction EC2 instance needs read-only access to Amazon Managed Blockchain
resources and the regional TLS certificate in S3.

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "ManagedBlockchainReadOnly",
      "Effect": "Allow",
      "Action": [
        "managedblockchain:GetNetwork",
        "managedblockchain:GetMember",
        "managedblockchain:GetNode",
        "managedblockchain:ListNetworks",
        "managedblockchain:ListMembers",
        "managedblockchain:ListNodes"
      ],
      "Resource": "*"
    },
    {
      "Sid": "TlsCertAccess",
      "Effect": "Allow",
      "Action": "s3:GetObject",
      "Resource": "arn:aws:s3:::*managedblockchain/etc/managedblockchain-tls-chain.pem"
    }
  ]
}
```

That covers every AMB call the toolkit makes, including `migrate`'s wizard — see
[Scoping to one network](#scoping-to-one-network) for which command needs which
action, and for how to narrow `Resource` without denying the pipeline.

For SSM Session Manager access to the EC2 instance, attach the
`AmazonSSMManagedInstanceCore` managed policy.

### Scoping to one network

The policy above uses `Resource: "*"`, which is the only thing that works for
`ListNetworks`. The rest can be scoped, but not by one ARN: AMB has three resource
types with three different shapes, and a network ARN is not a parent of its members
and nodes.

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "OneNetwork",
      "Effect": "Allow",
      "Action": [
        "managedblockchain:GetNetwork",
        "managedblockchain:ListMembers"
      ],
      "Resource": "arn:aws:managedblockchain:<region>::networks/<network-id>"
    },
    {
      "Sid": "OwnMemberAndItsNodes",
      "Effect": "Allow",
      "Action": [
        "managedblockchain:GetMember",
        "managedblockchain:ListNodes"
      ],
      "Resource": "arn:aws:managedblockchain:<region>:<account-id>:members/<member-id>"
    },
    {
      "Sid": "OwnNode",
      "Effect": "Allow",
      "Action": "managedblockchain:GetNode",
      "Resource": "arn:aws:managedblockchain:<region>:<account-id>:nodes/<node-id>"
    },
    {
      "Sid": "ListNetworksTakesNoResource",
      "Effect": "Allow",
      "Action": "managedblockchain:ListNetworks",
      "Resource": "*"
    }
  ]
}
```

Three things about those ARNs deny the whole pipeline if you get them wrong:

- **A network ARN has an empty account field.** A network is shared by every
  member's account and associated with none of them. Members and nodes are yours,
  and their ARNs must carry your account ID.
- **Member and node ARNs are flat, not nested under the network.** There is no
  `networks/<network-id>/members/...` form, and nothing follows `<network-id>` in a
  network ARN either — a trailing `/*` matches no network and denies `GetNetwork`.
- **`ListNetworks` has no resource type at all.** Naming any ARN for it denies it.

Which actions you need depends on the command. `discover` and `extract` resolve
endpoints from the IDs you pass, so they call `GetNetwork`, `GetMember` and
`GetNode` and nothing else. The three `List*` actions are for `migrate`, whose
wizard enumerates the region's Fabric networks, then your members of the one you
pick, then that member's nodes. A role that will only ever run `discover` and
`extract` with explicit IDs can drop all three, and then needs no `Resource: "*"`
statement.

## Replay to DynamoDB (optional)

Only required when using the `dynamodb` replay adapter.

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "DynamoDBReplay",
      "Effect": "Allow",
      "Action": [
        "dynamodb:CreateTable",
        "dynamodb:DescribeTable",
        "dynamodb:BatchWriteItem",
        "dynamodb:UpdateItem",
        "dynamodb:GetItem",
        "dynamodb:Query",
        "dynamodb:Scan"
      ],
      "Resource": "arn:aws:dynamodb:<region>:<account-id>:table/fabric-*"
    }
  ]
}
```

There is no default table name and no `fabric-` prefix in the adapter — every name
comes from the config's `dynamodb` section, `stateTable` required and the other four
optional. The `fabric-*` wildcard above matches the names the shipped example
configs use; if you choose your own, the ARN has to match what you chose, or the
first run fails at `CreateTable`.

The last three actions are `verify`, not `replay`: `GetItem` per state key,
`Query` per key history, and one `Scan` per channel for the sweep that finds
destination keys the extraction does not account for. A role with write
permissions alone replays successfully and then cannot check its own work.

## Replay to Fabric / PostgreSQL

The `chaincode` and `postgresql` replay adapters connect directly to the
destination network or database over the network. They do not use AWS APIs and
require no IAM permissions.

## Summary

| Phase | AWS Service | Permissions |
|-------|------------|-------------|
| `discover`, `extract` | Managed Blockchain | `GetNetwork`, `GetMember`, `GetNode` |
| `migrate` (wizard) | Managed Blockchain | the three above, plus `ListNetworks`, `ListMembers`, `ListNodes` |
| Extraction | S3 | `GetObject` (TLS cert) |
| EC2 access | SSM | `AmazonSSMManagedInstanceCore` |
| Replay (DynamoDB) | DynamoDB | `CreateTable`, `DescribeTable`, `BatchWriteItem`, `UpdateItem` |
| Verify (DynamoDB) | DynamoDB | `GetItem`, `Query`, `Scan` |
| Replay (chaincode) | None | Direct gRPC to Fabric peer |
| Replay (PostgreSQL) | None | Direct TCP to database |
