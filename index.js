#!/usr/bin/env node

const AWS = require("aws-sdk");
const axios = require("axios");

async function run(options) {
  const { group, regions, ports, url } = options;
  const { data } = await axios(url);
  const ip = data.trim();
  console.log("using ip " + ip);

  const iam = new AWS.IAM();
  const date = new Date().toISOString().slice(0, 16);

  const {
    User: { UserName: userName }
  } = await iam.getUser().promise();

  for (let region of regions) {
    AWS.config.update({ region: region });
    const ec2 = new AWS.EC2();
    const { SecurityGroups: securityGroups } = await ec2
      .describeSecurityGroups({
        GroupNames: [group]
      })
      .promise();
    if (securityGroups == undefined) {
      throw "No security groups found with name " + group;
    }
    if (securityGroups.length != 1) {
      throw "Should only be 1 security group but was " + securityGroups.length;
    }

    const securityGroup = securityGroups[0];

    const groupId = securityGroup.GroupId;
    console.log(region + " found group " + groupId);

    let ipPermissions = securityGroup.IpPermissions
      // only change permissions for the current user
      .filter(permission => {
        return (
          permission.IpRanges &&
          permission.IpRanges.some(
            range =>
              range.Description === `${userName}`
          ) && 
          ports.includes(permission.ToPort)
        );
      })
      .map(permission => {
        const result = {};
        Object.keys(permission).forEach(key => {
          if (permission[key]) {
            if (Array.isArray(permission[key])) {
              if (permission[key].length > 0) {
                result[key] = permission[key];
              }
            } else {
              result[key] = permission[key];
            }
          }
        });
        return result;
      });
    
    let newIpPermissions = [];

    if (ipPermissions.length > 0) {
      await ec2
        .revokeSecurityGroupIngress({
          GroupId: groupId,
          IpPermissions: ipPermissions
        })
        .promise();  

      newIpPermissions = ports.map(function(port) {
        const p = parseInt(port);
        let ret = null;
        ipPermissions.forEach(function(permission) {
          if(permission.ToPort === p) {
            let ipRanges = permission.IpRanges.map(function(range) {
              if(range.Description === `${userName}`) {
                return {
                  CidrIp: ip + "/32",
                  Description: `${userName}`
                };
              } else {
                return {
                  CidrIp: range.CidrIp,
                  Description: range.Description                 
                };
              }
            });
            ret = {            
              IpRanges: ipRanges,
              FromPort: p,
              ToPort: p,
              IpProtocol: "tcp"
            };
          }
        });
        
        if(!ret) {
          ret = {
            IpRanges: [
              {
                CidrIp: ip + "/32",
                Description: `${userName}`
              }
            ],
            FromPort: p,
            ToPort: p,
            IpProtocol: "tcp"
          };
        }
        return ret;
      });
    } else {
      newIpPermissions = ports.map(function(port) {
        const p = parseInt(port);
        return {
          IpRanges: [
            {
              CidrIp: ip + "/32",
              Description: `${userName}`
            }
          ],
          FromPort: p,
          ToPort: p,
          IpProtocol: "tcp"
        };
      });
    }

    await ec2
      .authorizeSecurityGroupIngress({
        GroupId: groupId,
        IpPermissions: newIpPermissions
      })
      .promise();

    console.log(
      region +
        " updated group " +
        groupId +
        " to ip " +
        ip +
        "/32 and ports " +
        ports
    );
  }
}

const argv = require("yargs")
  .usage("aws-access")
  .alias("p", "profile")
  .alias("g", "group")
  .alias("r", "regions")
  .alias("P", "ports")
  .alias("u", "url")
  .array("P")
  .array("r")
  .demand(["g"])
  .default("r", "us-east-1")
  .default("P", ["22"])
  .default("u", "http://checkip.amazonaws.com/")
  .help("h").argv;

if (argv.profile) {
  const credentials = new AWS.SharedIniFileCredentials({
    profile: argv.profile
  });
  AWS.config.credentials = credentials;
}

run(argv)
  .then(function() {
    console.log("done");
    process.exit(0);
  })
  .catch(function(error) {
    console.log(error.stack);
    process.exit(1);
  });
